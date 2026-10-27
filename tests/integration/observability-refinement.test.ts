import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { IntegrationFixture, eventually, postTransaction, testDatabaseUrl, type ManagedProcess } from './fixtures';

let fixture: IntegrationFixture;
let api: ManagedProcess;
beforeAll(async () => {
  fixture = await IntegrationFixture.initialize();
  api = await fixture.spawn('api');
}, 60000);
afterAll(async () => { if (fixture) await fixture.close(); }, 30000);

function gauge(text: string, name: string, labels = ''): number {
  const line = text.split('\n').find(line => line.startsWith(`${name}${labels} `));
  if (!line) throw new Error(`Missing metric ${name}${labels}`);
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('Persisted status, backlog and structured telemetry', () => {
  test('metrics reflect worker transitions and FAILED rows without counting a replay as another transaction', async () => {
    const wallet = await fixture.open();
    const bet = fixture.input(wallet);
    const first = await postTransaction(api, bet);
    const replay = await postTransaction(api, bet);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.idempotentReplay).toBe(true);
    const pending = await fixture.finance.submit(fixture.input(wallet, { kind: 'REFUND', referenceExternalTransactionId: randomUUID() }));
    await fixture.db.dataSource.query(`UPDATE wager_transactions SET attempts=999,next_attempt_at=now()-interval '1 second' WHERE id=$1`, [pending.transactionId]);
    await fixture.finance.retryPendingReferences();
    const failed = fixture.input(wallet);
    await fixture.finance.failPendingTransaction(failed, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
    const response = await fetch(`${api.url}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const totals = await fixture.db.dataSource.query('SELECT status,count(*)::integer AS total FROM wager_transactions GROUP BY status') as { status: string; total: number }[];
    for (const status of ['PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED']) {
      expect(gauge(text, 'wager_transactions', `{status="${status}"}`)).toBe(totals.find(row => row.status === status)?.total ?? 0);
    }
    expect(gauge(text, 'wager_metrics_dependency_up', '{dependency="postgresql"}')).toBe(1);
    expect(gauge(text, 'wager_metrics_dependency_up', '{dependency="sqs"}')).toBe(1);
    const [outbox] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM outbox_messages WHERE published_at IS NULL') as { n: number }[];
    expect(gauge(text, 'wager_outbox_pending_messages')).toBe(outbox!.n);
    expect(gauge(text, 'wager_outbox_oldest_age_seconds')).toBeGreaterThanOrEqual(0);
    expect(gauge(text, 'wager_dlq_messages')).toBe(await fixture.broker.deadLetterDepth());
    expect(gauge(text, 'wager_transaction_responses_total', '{status="PROCESSED"}')).toBe(2);
    await fixture.assertConsistent();
  });

  test('publisher logs keep the wallet distinct from a transaction aggregate and omit monetary payloads', async () => {
    const { OutboxPublisher } = await import('../../src/workers');
    const wallet = await fixture.open('3.21');
    const [transactionEvent] = await fixture.db.dataSource.query(`SELECT id,payload FROM outbox_messages
      WHERE event_type='WagerTransactionProcessed' AND payload->'data'->>'walletId'=$1`, [wallet.id]);
    expect(transactionEvent.payload.aggregateId).not.toBe(wallet.id);
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const publisher = new OutboxPublisher(fixture.db, fixture.broker);
      await eventually(async () => {
        await publisher.runOnce();
        const [row] = await fixture.db.dataSource.query('SELECT published_at FROM outbox_messages WHERE id=$1', [transactionEvent.id]);
        return row.published_at !== null;
      }, 20000, 'publisher telemetry fixture');
      const entry = output.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
        .find(row => row.event === 'outbox_event_published' && row.eventId === transactionEvent.id);
      expect(entry).toMatchObject({ walletId: wallet.id, transactionId: transactionEvent.payload.data.transactionId,
        providerId: '__internal__', correlationId: transactionEvent.payload.correlationId });
      expect(entry).not.toHaveProperty('payload');
      expect(JSON.stringify(entry)).not.toContain('3.21');
    } finally { output.mockRestore(); }
  });
});

test('reconciliation reports signed historical divergence, logs it, and never repairs data silently', async () => {
  const [{ Database }, { FinanceService }, { metrics }] = await Promise.all([
    import('../../src/infra/database'), import('../../src/application/finance.service'), import('../../src/infra/observability'),
  ]);
  // A separate, generated laboratory schema models historical inconsistent data.
  // LIKE copies column constraints, not triggers; no public financial guard is disabled.
  const schema = `refinement_observability_${randomUUID().replaceAll('-', '')}`;
  if (!/^refinement_observability_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected lab schema');
  console.log(JSON.stringify({ action: 'create_disposable_schema', schema, database: 'wager_test', cleanup: 'drop_only_this_generated_schema' }));
  await fixture.db.dataSource.query(`CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.wallets (LIKE public.wallets INCLUDING ALL);
    CREATE TABLE ${schema}.wallet_ledger (LIKE public.wallet_ledger INCLUDING ALL);`);
  const connection = new URL(testDatabaseUrl);
  connection.searchParams.set('options', `-c search_path=${schema}`);
  const lab = new Database(connection.toString());
  const walletId = randomUUID();
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await lab.initialize();
    expect((await lab.dataSource.query('SELECT current_schema() AS schema'))[0].schema).toBe(schema);
    await lab.dataSource.query(`INSERT INTO wallets(id,player_id,currency,balance,version,created_at,updated_at)
      VALUES($1,$2,'BRL','9.00',1,now(),now())`, [walletId, randomUUID()]);
    const finance = new FinanceService(lab);
    const before = metrics.render().split('\n').find(line => line.startsWith('wager_reconciliation_mismatches_total '));
    const initialCount = before ? Number(before.split(' ').at(-1)) : 0;
    expect(await finance.reconcile(walletId)).toMatchObject({ consistent: false, checkedEntries: 0,
      storedBalance: { amount: '9.00', currency: 'BRL' }, calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '9.00', currency: 'BRL' } });
    await lab.dataSource.query(`INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at)
      VALUES($1,$2,$3,'CREDIT','11.00','BRL','0.00','11.00',1,now())`, [randomUUID(), walletId, randomUUID()]);
    expect(await finance.reconcile(walletId)).toMatchObject({ consistent: false, checkedEntries: 1,
      storedBalance: { amount: '9.00' }, calculatedBalance: { amount: '11.00' }, difference: { amount: '-2.00' } });
    expect((await lab.dataSource.query('SELECT balance::text AS balance FROM wallets WHERE id=$1', [walletId]))[0].balance).toBe('9.00');
    expect((await lab.dataSource.query('SELECT amount::text AS amount FROM wallet_ledger WHERE wallet_id=$1', [walletId]))[0].amount).toBe('11.00');
    expect(gauge(metrics.render(), 'wager_reconciliation_mismatches_total')).toBe(initialCount + 2);
    const logs = output.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(logs.filter(log => log.event === 'reconciliation_mismatch' && log.walletId === walletId)).toHaveLength(2);
  } finally {
    output.mockRestore();
    await lab.close();
    await fixture.db.dataSource.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
