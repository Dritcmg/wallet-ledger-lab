import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  DeleteMessageBatchCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import type { TransactionResult } from '../../src/application/contracts';
import type { QueryRunner } from 'typeorm';
import {
  IntegrationFixture, eventually, postTransaction, requested, waitForExit,
  type ManagedProcess,
} from './fixtures';

let fixture: IntegrationFixture;
beforeAll(async () => { fixture = await IntegrationFixture.initialize(); }, 30_000);
afterAll(async () => { if (fixture) await fixture.close(); }, 30_000);

test('a producer killed after HTTP commit leaves unpublished events for three replacement workers', async () => {
  const { OutboxPublisher } = await import('../../src/workers');
  const publisher = new OutboxPublisher(fixture.db, fixture.broker);
  // Finish prior synthetic fixtures before creating this producer's events.
  await eventually(async () => {
    await publisher.runOnce();
    const [row] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM outbox_messages WHERE published_at IS NULL');
    return row.n === 0;
  }, 30_000, 'earlier synthetic outbox deliveries');

  const producer = await fixture.spawn('api');
  const replacements: ManagedProcess[] = [];
  try {
    const wallet = await fixture.open();
    const input = fixture.input(wallet);
    const response = await postTransaction(producer, input);
    expect(response.status).toBe(200);
    const transactionId = response.body.transactionId;
    const before = await fixture.db.dataSource.query(`SELECT id,published_at,payload FROM outbox_messages
      WHERE payload->'data'->>'transactionId'=$1 ORDER BY id`, [transactionId]) as { id: string; published_at: Date | null; payload: { eventId: string } }[];
    expect(before).toHaveLength(2);
    expect(before.every(event => event.published_at === null && event.id === event.payload.eventId)).toBe(true);
    // APP_ROLE=api has no publisher: these persisted events cannot have been sent.
    producer.child.kill('SIGKILL');
    const exit = await waitForExit(producer, 5000, 'producer death before publication');
    expect(exit).not.toBe(0);
    expect(producer.child.signalCode === 'SIGKILL' || exit === 137).toBe(true);

    replacements.push(...await Promise.all([fixture.spawn('worker'), fixture.spawn('worker'), fixture.spawn('worker')]));
    await eventually(async () => {
      const [row] = await fixture.db.dataSource.query(`SELECT count(*)::integer AS n FROM outbox_messages
        WHERE payload->'data'->>'transactionId'=$1 AND published_at IS NULL`, [transactionId]);
      return row.n === 0;
    }, 20_000, 'replacement processes publishing committed events');
    const after = await fixture.db.dataSource.query(`SELECT id,payload FROM outbox_messages
      WHERE payload->'data'->>'transactionId'=$1 ORDER BY id`, [transactionId]) as { id: string; payload: { eventId: string } }[];
    expect(after.map(event => event.id)).toEqual(before.map(event => event.id));
    expect(after.map(event => event.payload.eventId)).toEqual(before.map(event => event.payload.eventId));
    const ids = new Set(before.map(event => event.id));
    const deliveries = await receiveMatching(fixture.broker.eventsQueueUrl, message => {
      const event = JSON.parse(message.Body!) as { eventId: string };
      return ids.has(event.eventId);
    }, ids.size);
    expect(new Set(deliveries.map(message => (JSON.parse(message.Body!) as { eventId: string }).eventId))).toEqual(ids);
    expect(await ledgerCount(transactionId)).toBe(1);
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
    expect((await postTransaction(replacements[0]!, input)).body).toMatchObject({
      transactionId, idempotentReplay: true, balance: { amount: '75.00', currency: 'BRL' },
    });
    await fixture.assertConsistent();
    await Promise.all(replacements.map(process => fixture.stop(process)));
    for (const process of replacements) {
      expect(await process.child.exited).toBe(0);
      expect(await process.output).toContain('"event":"shutdown_completed"');
    }
  } finally {
    await Promise.all(replacements.map(process => fixture.stop(process)));
    await fixture.stop(producer);
  }
}, 75_000);

test('a reused inbox message ID with different contents reaches DLQ without replacing its hash or debit', async () => {
  const { SqsConsumer } = await import('../../src/workers');
  const wallet = await fixture.open();
  const input = fixture.input(wallet);
  const envelope = requested(input);
  const results: TransactionResult[] = [];
  const consumer = new SqsConsumer(fixture.finance, fixture.broker, { afterCommit: async result => { results.push(result); } });
  await sendInput(envelope, wallet.id);
  await eventually(async () => { await consumer.runOnce(); return results.length === 1; }, 15_000, 'original inbox message');
  const [before] = await fixture.db.dataSource.query(`SELECT payload_hash,transaction_id FROM inbox_messages
    WHERE consumer_name=$1 AND message_id=$2`, [consumer.consumerName, envelope.messageId]) as { payload_hash: string; transaction_id: string }[];
  expect(before).toBeDefined();

  const divergent = { ...envelope, data: { ...input, money: { amount: '26.00', currency: 'BRL' } } };
  await sendInput(divergent, wallet.id);
  await consumer.runOnce();
  const deadLetters = await receiveMatching(fixture.broker.dlqUrl, message => {
    const body = JSON.parse(message.Body!) as { messageId?: string };
    return body.messageId === envelope.messageId;
  }, 1);
  expect(deadLetters).toHaveLength(1);
  expect(deadLetters[0]!.MessageAttributes?.failureCode?.StringValue).toBe('MESSAGE_CONFLICT');
  const after = await fixture.db.dataSource.query(`SELECT payload_hash,transaction_id FROM inbox_messages
    WHERE consumer_name=$1 AND message_id=$2`, [consumer.consumerName, envelope.messageId]);
  expect(after).toEqual([before]);
  expect(results).toHaveLength(1);
  expect(await ledgerCount(before!.transaction_id)).toBe(1);
  const [transactions] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM wager_transactions WHERE idempotency_key=$1', [input.idempotencyKey]);
  expect(transactions.n).toBe(1);
  expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
  await fixture.assertConsistent();
}, 45_000);

// Bun 1.4.4 on Windows terminates a SIGTERM child with 143 without invoking its
// registered handler (verified locally). Docker's Linux gate always runs this case.
test.skipIf(process.platform === 'win32')('real SIGTERM releases a SQL-blocked delivery before unlocking and recovery debits once', async () => {
  const { SqsConsumer } = await import('../../src/workers');
  const wallet = await fixture.open();
  const input = fixture.input(wallet);
  const envelope = requested(input);
  let runner: QueryRunner | undefined = fixture.db.dataSource.createQueryRunner();
  let worker: ManagedProcess | undefined;
  try {
    await runner.connect();
    await runner.startTransaction();
    const [backend] = await runner.query('SELECT pg_backend_pid() AS pid') as { pid: number }[];
    await runner.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [wallet.id]);
    worker = await fixture.spawn('worker');
    await sendInput(envelope, wallet.id);
    await eventually(async () => {
      const [row] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [backend!.pid]);
      return row.n > 0;
    }, 5000, 'consumer blocked on its fixture wallet lock');
    worker.child.kill('SIGTERM');
    expect(await waitForExit(worker, 5000, 'graceful worker SIGTERM')).toBe(0);
    const output = await worker.output;
    expect(output).toContain('"event":"sqs_inflight_released","count":1');
    expect(output).toContain('"event":"shutdown_completed"');
    expect(output).not.toContain('shutdown_deadline_exceeded');
    await eventually(async () => {
      const state = await fixture.broker.client.send(new GetQueueAttributesCommand({
        QueueUrl: fixture.broker.inputQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }));
      return state.Attributes?.ApproximateNumberOfMessages === '1' && state.Attributes?.ApproximateNumberOfMessagesNotVisible === '0';
    }, 5000, 'source delivery visible before releasing the SQL lock');
    const [uncommitted] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM inbox_messages WHERE message_id=$1', [envelope.messageId]);
    expect(uncommitted.n).toBe(0);
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('100.00');
    await runner.rollbackTransaction();
    await runner.release();
    runner = undefined;
    await new SqsConsumer(fixture.finance, fixture.broker).runOnce();
    const inbox = await fixture.db.dataSource.query('SELECT transaction_id FROM inbox_messages WHERE message_id=$1', [envelope.messageId]) as { transaction_id: string }[];
    expect(inbox).toHaveLength(1);
    expect(await ledgerCount(inbox[0]!.transaction_id)).toBe(1);
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
    await fixture.assertConsistent();
  } finally {
    if (runner) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    if (worker) await fixture.stop(worker);
  }
}, 45_000);

async function ledgerCount(transactionId: string): Promise<number> {
  const [row] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM wallet_ledger WHERE transaction_id=$1', [transactionId]);
  return row.n;
}

async function sendInput(envelope: unknown, group: string): Promise<void> {
  await fixture.broker.client.send(new SendMessageCommand({
    QueueUrl: fixture.broker.inputQueueUrl, MessageBody: JSON.stringify(envelope),
    MessageGroupId: group, MessageDeduplicationId: randomUUID(),
  }));
}

async function receiveMatching(queueUrl: string, accepts: (message: Message) => boolean, expected: number): Promise<Message[]> {
  const found: Message[] = [];
  await eventually(async () => {
    const response = await fixture.broker.client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'],
    }));
    const messages = response.Messages ?? [];
    found.push(...messages.filter(accepts));
    if (messages.length) await fixture.broker.client.send(new DeleteMessageBatchCommand({
      QueueUrl: queueUrl, Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle! })),
    }));
    return found.length >= expected;
  }, 30_000, `receiving ${expected} matching synthetic messages`);
  return found;
}
