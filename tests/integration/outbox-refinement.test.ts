import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { IntegrationFixture, eventually, waitForExit, type ManagedProcess } from './fixtures';
import type { PublishableEvent } from '../../src/infra/sqs';

let fixture: IntegrationFixture;
beforeAll(async () => { fixture = await IntegrationFixture.initialize(); }, 30_000);
afterAll(async () => { if (fixture) await fixture.close(); }, 30_000);

interface PendingEvent {
  id: string;
  published_at: Date | null;
  locked_until: Date | null;
  claim_token: string | null;
  attempts: number;
  payload: { eventId: string; [key: string]: unknown };
}

async function eventsFor(walletId: string): Promise<PendingEvent[]> {
  return fixture.db.dataSource.query(`SELECT id,published_at,locked_until,claim_token,attempts,payload
    FROM outbox_messages WHERE aggregate_id=$1::uuid OR payload->'data'->>'walletId'=$1::text
    ORDER BY id`, [walletId]) as Promise<PendingEvent[]>;
}

async function finishEarlierEvents(): Promise<void> {
  const { OutboxPublisher } = await import('../../src/workers/outbox-publisher');
  const publisher = new OutboxPublisher(fixture.db, fixture.broker);
  await eventually(async () => {
    await publisher.runOnce();
    const [row] = await fixture.db.dataSource.query('SELECT count(*)::integer AS pending FROM outbox_messages WHERE published_at IS NULL');
    return row.pending === 0;
  }, 30_000, 'earlier synthetic outbox events');
}

async function receiveEventIds(expected: Set<string>, payloads: Map<string, PendingEvent['payload']>): Promise<Set<string>> {
  const received = new Set<string>();
  await eventually(async () => {
    const response = await fixture.broker.client.send(new ReceiveMessageCommand({
      QueueUrl: fixture.broker.eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
    }));
    const messages = response.Messages ?? [];
    for (const message of messages) {
      const event = JSON.parse(message.Body!) as PendingEvent['payload'];
      if (expected.has(event.eventId)) {
        const expectedPayload = payloads.get(event.eventId);
        if (!expectedPayload) throw new Error('A matching event is missing its expected persisted payload.');
        expect(event).toEqual(expectedPayload);
        received.add(event.eventId);
      }
    }
    if (messages.length) await fixture.broker.client.send(new DeleteMessageBatchCommand({
      QueueUrl: fixture.broker.eventsQueueUrl,
      Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle! })),
    }));
    return received.size === expected.size;
  }, 30_000, 'original integration event IDs on real SQS');
  return received;
}

test('a publisher killed after its real SQL claim is recovered after lease expiry with the original event IDs', async () => {
  await finishEarlierEvents();
  const wallet = await fixture.open();
  const [ledgerBefore] = await fixture.db.dataSource.query('SELECT count(*)::integer AS entries FROM wallet_ledger WHERE wallet_id=$1', [wallet.id]);
  const original = await eventsFor(wallet.id);
  expect(original).toHaveLength(2);
  expect(original.every(event => event.published_at === null && event.claim_token === null)).toBe(true);

  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'publisher-crash.fixture.ts')], {
    cwd: process.cwd(), env: { ...process.env, OUTBOX_LEASE_SECONDS: '1', TEST_PUBLISHER_CRASH: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const managed: ManagedProcess = {
    child,
    output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(parts => parts.join('\n')),
  };
  fixture.processes.add(managed);
  try {
    const exit = await waitForExit(managed, 10_000, 'publisher SIGKILL after claim commit');
    expect(child.signalCode === 'SIGKILL' || exit === 137).toBe(true);
    expect(await managed.output).toContain('publisher_claim_committed_before_crash');
    const claimed = await eventsFor(wallet.id);
    expect(claimed.every(event => event.published_at === null && event.claim_token !== null && event.locked_until !== null && event.attempts === 1)).toBe(true);
    expect(new Set(claimed.map(event => event.claim_token)).size).toBe(1);

    const { OutboxPublisher } = await import('../../src/workers/outbox-publisher');
    const recovery = new OutboxPublisher(fixture.db, fixture.broker);
    // The original one-second lease expires naturally; no SQL bypass releases it.
    await eventually(async () => {
      await recovery.runOnce();
      return (await eventsFor(wallet.id)).every(event => event.published_at !== null);
    }, 15_000, 'lease expiry and takeover by a real publisher');
    const recovered = await eventsFor(wallet.id);
    expect(recovered.map(event => event.id)).toEqual(original.map(event => event.id));
    expect(recovered.map(event => event.payload)).toEqual(original.map(event => event.payload));
    expect(recovered.every(event => event.attempts === 2 && event.claim_token === null && event.locked_until === null && event.payload.eventId === event.id)).toBe(true);
    const ids = new Set(original.map(event => event.id));
    expect(await receiveEventIds(ids, new Map(original.map(event => [event.id, event.payload])))).toEqual(ids);
    const [ledgerAfter] = await fixture.db.dataSource.query('SELECT count(*)::integer AS entries FROM wallet_ledger WHERE wallet_id=$1', [wallet.id]);
    expect(ledgerAfter.entries).toBe(ledgerBefore.entries);
    expect(await fixture.finance.getWallet(wallet.id)).toEqual(wallet);
    await fixture.assertConsistent();
  } finally { await fixture.stop(managed); }
}, 60_000);

test('a publisher that loses its token after a real send cannot finalize or clear the new owners claim', async () => {
  await finishEarlierEvents();
  const wallet = await fixture.open();
  const [ledgerBefore] = await fixture.db.dataSource.query('SELECT count(*)::integer AS entries FROM wallet_ledger WHERE wallet_id=$1', [wallet.id]);
  const original = await eventsFor(wallet.id);
  const ids = new Set(original.map(event => event.id));
  expect(ids.size).toBe(2);
  let release!: () => void;
  const latch = new Promise<void>(resolve => { release = resolve; });
  const sent = new Set<string>();
  const { SqsBroker } = await import('../../src/infra/sqs');
  const { OutboxPublisher } = await import('../../src/workers/outbox-publisher');
  class PauseAfterRealSendBroker extends SqsBroker {
    override async publishEvent(event: PublishableEvent): Promise<void> {
      await super.publishEvent(event);
      if (ids.has(event.eventId)) { sent.add(event.eventId); await latch; }
    }
  }
  const oldBroker = new PauseAfterRealSendBroker();
  await oldBroker.initialize();
  const work = new OutboxPublisher(fixture.db, oldBroker).runOnce();
  try {
    await eventually(async () => sent.size === ids.size, 15_000, 'real sends paused before publisher acknowledgement');
    const claimed = await eventsFor(wallet.id);
    expect(claimed.every(event => event.published_at === null && event.claim_token !== null)).toBe(true);
    const nextOwner = randomUUID();
    // Simulate another owner while the old network calls are still in flight.
    await fixture.db.dataSource.query(`UPDATE outbox_messages SET claim_token=$2,
      locked_until=now()+interval '30 seconds' WHERE id=ANY($1::uuid[])`, [[...ids], nextOwner]);
    const transferred = await eventsFor(wallet.id);
    release();
    expect(await work).toBe(2);
    const fenced = await eventsFor(wallet.id);
    expect(fenced.every(event => event.published_at === null && event.claim_token === nextOwner)).toBe(true);
    expect(fenced.map(event => event.locked_until)).toEqual(transferred.map(event => event.locked_until));

    // Expiring the fixture owner's lease lets the application execute its own
    // normal claim and guarded acknowledgement; the test does not copy that SQL.
    await fixture.db.dataSource.query(`UPDATE outbox_messages SET locked_until=now()-interval '1 second'
      WHERE id=ANY($1::uuid[]) AND claim_token=$2`, [[...ids], nextOwner]);
    expect(await new OutboxPublisher(fixture.db, fixture.broker).runOnce()).toBe(2);
    const recovered = await eventsFor(wallet.id);
    expect(recovered.every(event => event.published_at !== null && event.claim_token === null && event.locked_until === null && event.attempts === 2)).toBe(true);
    expect(recovered.map(event => event.id)).toEqual(original.map(event => event.id));
    expect(recovered.map(event => event.payload)).toEqual(original.map(event => event.payload));
    expect(await receiveEventIds(ids, new Map(original.map(event => [event.id, event.payload])))).toEqual(ids);
    const [ledgerAfter] = await fixture.db.dataSource.query('SELECT count(*)::integer AS entries FROM wallet_ledger WHERE wallet_id=$1', [wallet.id]);
    expect(ledgerAfter.entries).toBe(ledgerBefore.entries);
    expect(await fixture.finance.getWallet(wallet.id)).toEqual(wallet);
    await fixture.assertConsistent();
  } finally {
    release();
    await work;
    oldBroker.close();
  }
}, 60_000);
