import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Message } from '@aws-sdk/client-sqs';
import type { SubmitTransactionInput, TransactionResult } from '../../src/application/contracts';
import { IntegrationFixture, eventually, postTransaction, requested, sqlFailure, waitForExit } from './fixtures';

let fixture: IntegrationFixture;
beforeAll(async () => {
  fixture = await IntegrationFixture.initialize();
  await fixture.startApis();
}, 60_000);
afterAll(async () => { if (fixture) await fixture.close(); }, 30_000);

async function count(table: 'wallet_ledger' | 'wager_transactions' | 'inbox_messages' | 'outbox_messages', condition: string, params: unknown[]): Promise<number> {
  const [row] = await fixture.db.dataSource.query(`SELECT count(*)::integer AS n FROM ${table} WHERE ${condition}`, params) as { n: number }[];
  return row!.n;
}
function dependent(base: SubmitTransactionInput, kind: 'WIN' | 'REFUND' | 'ROLLBACK', overrides: Partial<SubmitTransactionInput> = {}): SubmitTransactionInput {
  const id = randomUUID();
  return { ...base, externalTransactionId: id, idempotencyKey: `key:${id}`, kind, referenceExternalTransactionId: base.externalTransactionId, ...overrides };
}

describe('Real PostgreSQL and three HTTP application processes', () => {
  test('wallet opening is atomic, zero has no ledger, and duplicate player/currency conflicts', async () => {
    const wallet = await fixture.open();
    expect(wallet.version).toBe(1);
    expect(await count('wallet_ledger', 'wallet_id=$1', [wallet.id])).toBe(1);
    expect(await count('wager_transactions', "wallet_id=$1 AND kind='OPENING' AND status='PROCESSED'", [wallet.id])).toBe(1);
    const events = await fixture.db.dataSource.query(`SELECT event_type FROM outbox_messages WHERE aggregate_id=$1::uuid OR payload->'data'->>'walletId'=$1::text`, [wallet.id]);
    expect(events.map((event: { event_type: string }) => event.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await expect(fixture.finance.openWallet({ playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } })).rejects.toMatchObject({ code: 'WALLET_EXISTS' });
    const empty = await fixture.open('0.00');
    expect(empty.version).toBe(1);
    expect(await count('wallet_ledger', 'wallet_id=$1', [empty.id])).toBe(0);
    expect(await count('wager_transactions', 'wallet_id=$1', [empty.id])).toBe(0);
    await fixture.assertConsistent();
  });

  test('50 identical requests through three processes debit once and replay the historical balance', async () => {
    const wallet = await fixture.open();
    const input = fixture.input(wallet);
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => postTransaction(fixture.apis[index % 3]!, input)));
    expect(responses.every(response => response.status === 200 && response.body.status === 'PROCESSED')).toBe(true);
    expect(new Set(responses.map(response => response.body.transactionId)).size).toBe(1);
    expect(responses.filter(response => !response.body.idempotentReplay)).toHaveLength(1);
    expect(responses.every(response => response.body.balance.amount === '75.00')).toBe(true);
    const result = responses[0]!.body;
    expect(await count('wallet_ledger', 'transaction_id=$1', [result.transactionId])).toBe(1);
    const laterWin = fixture.input(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await fixture.finance.submit(laterWin);
    const replay = await postTransaction(fixture.apis[1]!, input);
    expect(replay.body).toMatchObject({ transactionId: result.transactionId, balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: true });
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('125.00');
    const byId = await fetch(`${fixture.apis[0]!.url}/wagering/transactions/${result.transactionId}`);
    expect(await byId.json()).toMatchObject({ transactionId: result.transactionId, balance: { amount: '75.00' } });
    const byProvider = await fetch(`${fixture.apis[2]!.url}/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`);
    expect(await byProvider.json()).toMatchObject({ transactionId: result.transactionId });
    await fixture.assertConsistent();
  });

  test('two concurrent bets of 80 from 100 produce one debit and an audited rejection', async () => {
    const wallet = await fixture.open();
    const inputs = [fixture.input(wallet, { money: { amount: '80.00', currency: 'BRL' } }), fixture.input(wallet, { money: { amount: '80.00', currency: 'BRL' } })];
    const results = await Promise.all(inputs.map((input, index) => postTransaction(fixture.apis[index]!, input)));
    expect(results.map(result => result.status).sort()).toEqual([200, 422]);
    expect(results.map(result => result.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = results.find(result => result.body.status === 'REJECTED')!.body;
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await count('wallet_ledger', "wallet_id=$1 AND direction='DEBIT'", [wallet.id])).toBe(1);
    expect(await count('wallet_ledger', 'transaction_id=$1', [rejected.transactionId])).toBe(0);
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('20.00');
    expect((await postTransaction(fixture.apis[2]!, inputs[0]!)).body.idempotentReplay).toBe(true);
    await fixture.assertConsistent();
  });

  test('different wallets continue while another wallet is SQL-locked', async () => {
    const blocked = await fixture.open();
    const independent = await Promise.all(Array.from({ length: 6 }, () => fixture.open()));
    const runner = fixture.db.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let blockedFinished = false;
    let pending: ReturnType<typeof postTransaction> | undefined;
    try {
      await runner.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [blocked.id]);
      pending = postTransaction(fixture.apis[0]!, fixture.input(blocked)).then(result => { blockedFinished = true; return result; });
      const responses = await Promise.all(independent.map((wallet, index) => postTransaction(fixture.apis[index % 3]!, fixture.input(wallet))));
      expect(responses.every(response => response.body.status === 'PROCESSED')).toBe(true);
      expect(blockedFinished).toBe(false);
      await runner.commitTransaction();
      expect((await pending).body.status).toBe('PROCESSED');
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await pending;
    }
    await fixture.assertConsistent();
  });

  test('LOSS records an outcome without balance, version, ledger or balance event', async () => {
    const wallet = await fixture.open();
    const result = await fixture.finance.submit(fixture.input(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }));
    expect(result.status).toBe('PROCESSED');
    expect((await fixture.finance.getWallet(wallet.id)).version).toBe(1);
    expect(await count('wallet_ledger', 'transaction_id=$1', [result.transactionId])).toBe(0);
    const events = await fixture.db.dataSource.query(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1`, [result.transactionId]);
    expect(events.map((event: { event_type: string }) => event.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  test('WIN, REFUND and ROLLBACK follow reference rules and reverse once per operation kind', async () => {
    const wallet = await fixture.open();
    const bet = fixture.input(wallet);
    const betResult = await fixture.finance.submit(bet);
    const win = dependent(bet, 'WIN', { money: { amount: '40.00', currency: 'BRL' } });
    expect((await fixture.finance.submit(win)).balance.amount).toBe('115.00');
    const refund = dependent(bet, 'REFUND');
    expect((await fixture.finance.submit(refund)).balance.amount).toBe('140.00');
    const duplicateRefund = await fixture.finance.submit(dependent(bet, 'REFUND'));
    expect(duplicateRefund).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect((await fixture.finance.submit(dependent(win, 'ROLLBACK'))).balance.amount).toBe('100.00');
    expect((await fixture.finance.submit(dependent(refund, 'ROLLBACK'))).balance.amount).toBe('75.00');
    expect((await fixture.finance.submit(dependent(bet, 'ROLLBACK'))).balance.amount).toBe('100.00');
    expect(await count('wallet_ledger', 'transaction_id=$1', [betResult.transactionId])).toBe(1);
    expect((await fixture.finance.submit(dependent(bet, 'ROLLBACK'))).failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await fixture.finance.submit(dependent(win, 'REFUND'))).failureCode).toBe('INVALID_REFERENCE_KIND');
    expect((await fixture.finance.submit(dependent(bet, 'REFUND', { money: { amount: '24.99', currency: 'BRL' } }))).failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect((await fixture.finance.submit(dependent(bet, 'WIN', { roundId: randomUUID() }))).failureCode).toBe('REFERENCE_MISMATCH');
    await fixture.assertConsistent();
  });

  test('a rollback that would make balance negative has a distinct rejection code', async () => {
    const wallet = await fixture.open('0.00');
    const win = fixture.input(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await fixture.finance.submit(win);
    await fixture.finance.submit(fixture.input(wallet, { money: { amount: '40.00', currency: 'BRL' } }));
    const reversal = await fixture.finance.submit(dependent(win, 'ROLLBACK'));
    expect(reversal).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS_FOR_REVERSAL', balance: { amount: '10.00', currency: 'BRL' } });
    expect(await count('wallet_ledger', 'transaction_id=$1', [reversal.transactionId])).toBe(0);
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('10.00');
  });

  test('reference delivered later is reprocessed and exhausted references reject auditably', async () => {
    const wallet = await fixture.open();
    const bet = fixture.input(wallet);
    const refund = dependent(bet, 'REFUND');
    const waiting = await postTransaction(fixture.apis[0]!, refund);
    expect(waiting.status).toBe(202);
    expect(waiting.body.status).toBe('PENDING_REFERENCE');
    expect(await count('wallet_ledger', 'transaction_id=$1', [waiting.body.transactionId])).toBe(0);
    await fixture.finance.submit(bet);
    await fixture.db.dataSource.query("UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [waiting.body.transactionId]);
    const { PendingReferenceWorker } = await import('../../src/workers');
    await new PendingReferenceWorker(fixture.finance).runOnce();
    const completed = await fixture.finance.getTransaction(waiting.body.transactionId);
    expect(completed.status).toBe('PROCESSED');
    expect(completed.balance.amount).toBe('100.00');
    const missing = await fixture.finance.submit(fixture.input(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: randomUUID() }));
    await fixture.db.dataSource.query("UPDATE wager_transactions SET attempts=3,next_attempt_at=now()-interval '1 second' WHERE id=$1", [missing.transactionId]);
    await new PendingReferenceWorker(fixture.finance).runOnce();
    expect(await fixture.finance.getTransaction(missing.transactionId)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await count('outbox_messages', "event_type='WagerTransactionRejected' AND aggregate_id=$1", [missing.transactionId])).toBe(1);
    await fixture.assertConsistent();
  });

  test('currency mismatch is persisted as rejected; same key with different payload returns conflict', async () => {
    const wallet = await fixture.open();
    const mismatch = await postTransaction(fixture.apis[0]!, fixture.input(wallet, { money: { amount: '1.00', currency: 'USD' } }));
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(await count('wallet_ledger', 'transaction_id=$1', [mismatch.body.transactionId])).toBe(0);
    const input = fixture.input(wallet);
    await postTransaction(fixture.apis[0]!, input);
    const conflict = await postTransaction(fixture.apis[2]!, { ...input, money: { amount: '30.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
    await fixture.assertConsistent();
  });

  test('HTTP validates the header, external OPENING, body shape and stable ledger pagination', async () => {
    const wallet = await fixture.open();
    const input = fixture.input(wallet);
    const { idempotencyKey: _key, ...body } = input;
    const noKey = await fetch(`${fixture.apis[0]!.url}/wagering/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(noKey.status).toBe(400);
    const opening = await fetch(`${fixture.apis[0]!.url}/wagering/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey }, body: JSON.stringify({ ...body, kind: 'OPENING' }) });
    expect(opening.status).toBe(400);
    const unknownField = await fetch(`${fixture.apis[0]!.url}/wagering/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey }, body: JSON.stringify({ ...body, unexpected: true }) });
    expect(unknownField.status).toBe(400);
    await fixture.finance.submit(input);
    await fixture.finance.submit(fixture.input(wallet, { kind: 'WIN' }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await fetch(`${fixture.apis[0]!.url}/wallets/${wallet.id}/ledger?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.status).toBe(200);
      const page = await response.json() as { items: { id: string; walletVersion: number }[]; nextCursor: string | null };
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    const malformed = await fetch(`${fixture.apis[0]!.url}/wallets/${wallet.id}/ledger?cursor=bad`);
    expect(malformed.status).toBe(400);
    const reconciliation = await fetch(`${fixture.apis[0]!.url}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    expect(await reconciliation.json()).toMatchObject({ consistent: true, difference: { amount: '0.00', currency: 'BRL' } });
  });

  test('exhausted delivery cannot fail another payload and genuine failures retain their audit event', async () => {
    const wallet = await fixture.open();
    const legitimate = fixture.input(wallet, { kind: 'REFUND', referenceExternalTransactionId: randomUUID() });
    const waiting = await fixture.finance.submit(legitimate);
    expect(waiting.status).toBe('PENDING_REFERENCE');
    await fixture.finance.failPendingTransaction({ ...legitimate, money: { amount: '26.00', currency: 'BRL' } }, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
    expect((await fixture.finance.getTransaction(waiting.transactionId)).status).toBe('PENDING_REFERENCE');
    const otherWallet = await fixture.open();
    await fixture.finance.failPendingTransaction({ ...legitimate, walletId: otherWallet.id, playerId: otherWallet.playerId }, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
    expect((await fixture.finance.getTransaction(waiting.transactionId)).status).toBe('PENDING_REFERENCE');
    await fixture.finance.failPendingTransaction(legitimate, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
    expect(await fixture.finance.getTransaction(waiting.transactionId)).toMatchObject({ status: 'FAILED', failureCode: 'INFRASTRUCTURE_RETRY_EXHAUSTED' });
    expect(await count('outbox_messages', "event_type='WagerTransactionFailed' AND aggregate_id=$1", [waiting.transactionId])).toBe(1);
    expect(await count('wallet_ledger', 'transaction_id=$1', [waiting.transactionId])).toBe(0);
    const neverAccepted = fixture.input(wallet);
    await fixture.finance.failPendingTransaction(neverAccepted, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
    expect(await fixture.finance.getProviderTransaction(neverAccepted.providerId, neverAccepted.externalTransactionId)).toMatchObject({ status: 'FAILED', failureCode: 'INFRASTRUCTURE_RETRY_EXHAUSTED' });
    await fixture.assertConsistent();
  });
});

describe('SQL schema enforcement without bypassing ledger guards', () => {
  test('ledger UPDATE/DELETE and unmatched balance writes fail and leave the wallet untouched', async () => {
    const wallet = await fixture.open();
    const [entry] = await fixture.db.dataSource.query('SELECT * FROM wallet_ledger WHERE wallet_id=$1', [wallet.id]);
    await sqlFailure(() => fixture.db.dataSource.query('UPDATE wallet_ledger SET amount=amount WHERE id=$1', [entry.id]), '55000');
    await sqlFailure(() => fixture.db.dataSource.query('DELETE FROM wallet_ledger WHERE id=$1', [entry.id]), '55000');
    await sqlFailure(() => fixture.db.transaction(manager => manager.query('UPDATE wallets SET balance=balance+1,version=version+1 WHERE id=$1', [wallet.id])), '23514');
    await sqlFailure(() => fixture.db.dataSource.query('UPDATE wallets SET balance=-1,version=version+1 WHERE id=$1', [wallet.id]), '23514');
    await sqlFailure(() => fixture.db.dataSource.query('UPDATE wallets SET version=version+1 WHERE id=$1', [wallet.id]), '23514');
    await sqlFailure(() => fixture.db.dataSource.query("UPDATE wager_transactions SET status='PENDING' WHERE id=$1", [entry.transaction_id]), '23514');
    await sqlFailure(() => fixture.db.dataSource.query('DELETE FROM wager_transactions WHERE id=$1', [entry.transaction_id]), '55000');
    await sqlFailure(() => fixture.db.transaction(manager => manager.query(`INSERT INTO wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,result_balance,result_currency,processed_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'round','game','LOSS',0,'USD','PROCESSED',100,'BRL',now(),now())`,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), wallet.id, randomUUID()])), '23514');
    await sqlFailure(() => fixture.db.dataSource.query(`INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at)
      VALUES($1,$2,$3,'CREDIT',100,'BRL',0,100,2,now())`, [randomUUID(), wallet.id, entry.transaction_id]), '23505');
    await sqlFailure(() => fixture.db.dataSource.query(`INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at)
      VALUES($1,$2,$3,'CREDIT',1,'BRL',100,102,2,now())`, [randomUUID(), wallet.id, randomUUID()]), '23514');
    expect((await fixture.finance.getWallet(wallet.id))).toMatchObject({ balance: { amount: '100.00' }, version: 1 });
    expect(await count('wallet_ledger', 'wallet_id=$1', [wallet.id])).toBe(1);
    await fixture.assertConsistent();
  });

  test('financial transaction rolls back inbox, wallet, ledger and outbox together', async () => {
    const wallet = await fixture.open();
    const input = fixture.input(wallet);
    const messageId = randomUUID();
    // A temporary trigger injects a real PostgreSQL failure at the final inbox INSERT.
    const suffix = randomUUID().replaceAll('-', '');
    const name = `integration_fail_${suffix}`;
    await fixture.db.dataSource.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.message_id='${messageId}' THEN RAISE EXCEPTION 'injected final write failure' USING ERRCODE='23514'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT ON inbox_messages FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await sqlFailure(() => fixture.finance.submit(input, { inbox: { messageId, consumerName: 'atomicity', payloadHash: 'hash' } }), '23514');
      expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('100.00');
      expect(await count('wager_transactions', 'idempotency_key=$1', [input.idempotencyKey])).toBe(0);
      expect(await count('wallet_ledger', 'wallet_id=$1', [wallet.id])).toBe(1);
      expect(await count('inbox_messages', 'message_id=$1', [messageId])).toBe(0);
      expect(await count('outbox_messages', "payload->'data'->>'externalTransactionId'=$1", [input.externalTransactionId])).toBe(0);
      // WalletBalanceChanged has no externalTransactionId; inspect its wallet scope as well.
      expect(await count('outbox_messages', "payload->'data'->>'walletId'=$1", [wallet.id])).toBe(2);
    } finally {
      await fixture.db.dataSource.query(`DROP TRIGGER ${name} ON inbox_messages; DROP FUNCTION ${name}()`);
    }
    expect((await fixture.finance.submit(input)).status).toBe('PROCESSED');
    await fixture.assertConsistent();
  });

  test('migration up/down/up succeeds in a new isolated schema', async () => {
    const { Initial1730000000000 } = await import('../../src/infra/migrations/1730000000000-Initial');
    const { AuditGuards1730000001000 } = await import('../../src/infra/migrations/1730000001000-AuditGuards');
    const name = `integration_${randomUUID().replaceAll('-', '')}`;
    const runner = fixture.db.dataSource.createQueryRunner();
    await runner.connect();
    await runner.query(`CREATE SCHEMA ${name}`);
    try {
      await runner.query(`SET search_path TO ${name}`);
      const migration = new Initial1730000000000();
      const auditMigration = new AuditGuards1730000001000();
      await migration.up(runner);
      await auditMigration.up(runner);
      let [row] = await runner.query("SELECT to_regclass('wallets')::text AS wallets");
      expect(row.wallets).toBe('wallets');
      await auditMigration.down(runner);
      await migration.down(runner);
      [row] = await runner.query("SELECT to_regclass('wallets')::text AS wallets");
      expect(row.wallets).toBeNull();
      await migration.up(runner);
      await auditMigration.up(runner);
      [row] = await runner.query("SELECT count(*)::integer AS n FROM pg_trigger WHERE tgrelid='wallet_ledger'::regclass AND NOT tgisinternal");
      expect(row.n).toBeGreaterThanOrEqual(4);
    } finally {
      await runner.query('SET search_path TO public');
      await runner.query(`DROP SCHEMA ${name} CASCADE`);
      await runner.release();
    }
  });
});

describe('Real SQS inbox, transactional outbox and process recovery', () => {
  test('two publishers claim disjoint outbox batches and deliver committed envelopes', async () => {
    const { OutboxPublisher } = await import('../../src/workers');
    const wallet = await fixture.open();
    const result = await fixture.finance.submit(fixture.input(wallet));
    const rows = await fixture.db.dataSource.query(`SELECT id FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1`, [result.transactionId]) as { id: string }[];
    const expected = new Set(rows.map(row => row.id));
    expect(expected.size).toBe(2);
    const publishers = [new OutboxPublisher(fixture.db, fixture.broker), new OutboxPublisher(fixture.db, fixture.broker)];
    await eventually(async () => {
      await Promise.all(publishers.map(publisher => publisher.runOnce()));
      return await count('outbox_messages', 'id=ANY($1::uuid[]) AND published_at IS NULL', [[...expected]]) === 0;
    }, 30_000, 'concurrent outbox publication');
    const attempts = await fixture.db.dataSource.query('SELECT attempts,claim_token,locked_until FROM outbox_messages WHERE id=ANY($1::uuid[])', [[...expected]]);
    expect(attempts.every((row: { attempts: number; claim_token: string | null; locked_until: Date | null }) => row.attempts === 1 && row.claim_token === null && row.locked_until === null)).toBe(true);
    const received = await collectMessages(fixture.broker.eventsQueueUrl, message => expected.has((JSON.parse(message.Body!) as { eventId: string }).eventId), expected.size);
    expect(received).toHaveLength(expected.size);
    expect(new Set(received.map(message => (JSON.parse(message.Body!) as { eventId: string }).eventId)).size).toBe(expected.size);
  });

  test('a real broker publication error persists retry state and another publisher recovers', async () => {
    const [{ OutboxPublisher }, { SqsBroker }, { SQSClient }] = await Promise.all([import('../../src/workers'), import('../../src/infra/sqs'), import('@aws-sdk/client-sqs')]);
    const wallet = await fixture.open();
    const rows = await fixture.db.dataSource.query(`SELECT id FROM outbox_messages WHERE aggregate_id=$1::uuid OR payload->'data'->>'walletId'=$1::text`, [wallet.id]) as { id: string }[];
    const ids = rows.map(row => row.id);
    const broken = new SqsBroker(new SQSClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1', useQueueUrlAsEndpoint: false,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1, requestHandler: { connectionTimeout: 200, requestTimeout: 200 } }));
    broken.eventsQueueUrl = fixture.broker.eventsQueueUrl;
    try {
      const publisher = new OutboxPublisher(fixture.db, broken);
      await eventually(async () => { await publisher.runOnce(); return await count('outbox_messages', 'id=ANY($1::uuid[]) AND attempts>0 AND published_at IS NULL AND next_attempt_at>now()', [ids]) === ids.length; }, 15_000, 'persisted broker retry');
    } finally { broken.close(); }
    await fixture.db.dataSource.query("UPDATE outbox_messages SET next_attempt_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])", [ids]);
    const recovery = new OutboxPublisher(fixture.db, fixture.broker);
    await eventually(async () => { await recovery.runOnce(); return await count('outbox_messages', 'id=ANY($1::uuid[]) AND published_at IS NULL', [ids]) === 0; }, 20_000, 'outbox recovery');
  });

  test('redelivered business message with distinct SQS delivery IDs creates one inbox and debit', async () => {
    const { SqsConsumer } = await import('../../src/workers');
    const wallet = await fixture.open();
    const input = fixture.input(wallet);
    const envelope = requested(input);
    await sendInput(JSON.stringify(envelope), wallet.id);
    await sendInput(JSON.stringify(envelope), wallet.id);
    const results: TransactionResult[] = [];
    const consumer = new SqsConsumer(fixture.finance, fixture.broker, { afterCommit: async result => { results.push(result); } });
    await eventually(async () => { await consumer.runOnce(); return results.length >= 2; }, 25_000, 'SQS duplicate deliveries');
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter(result => result.idempotentReplay)).toHaveLength(1);
    expect(await count('inbox_messages', 'message_id=$1', [envelope.messageId])).toBe(1);
    expect(await count('wallet_ledger', 'transaction_id=$1', [results[0]!.transactionId])).toBe(1);
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
    await fixture.assertConsistent();
  });

  test('malformed contract moves to the real DLQ with a stable failure code', async () => {
    const { SqsConsumer } = await import('../../src/workers');
    const invalid = `malformed-${randomUUID()}`;
    await sendInput(invalid, randomUUID());
    await new SqsConsumer(fixture.finance, fixture.broker).runOnce();
    const messages = await collectMessages(fixture.broker.dlqUrl, message => message.Body === invalid, 1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.MessageAttributes?.failureCode?.StringValue).toBe('INVALID_MESSAGE_CONTRACT');
  });

  test('a real PostgreSQL serialization error leaves SQS unacked and redelivery recovers', async () => {
    const { SqsConsumer } = await import('../../src/workers');
    const wallet = await fixture.open();
    const envelope = requested(fixture.input(wallet));
    const removeFailure = await injectSerializationFailure(wallet.id);
    const consumer = new SqsConsumer(fixture.finance, fixture.broker);
    await sendInput(JSON.stringify(envelope), wallet.id);
    try {
      await consumer.runOnce();
      expect(await count('inbox_messages', 'message_id=$1', [envelope.messageId])).toBe(0);
      expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('100.00');
    } finally { await removeFailure(); }
    await eventually(async () => { await consumer.runOnce(); return await count('inbox_messages', 'message_id=$1', [envelope.messageId]) === 1; }, 20_000, 'successful redelivery after database recovery');
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
    await fixture.assertConsistent();
  });

  test('retry budget exhaustion sends a real message to DLQ without a partial debit', async () => {
    const { SqsConsumer } = await import('../../src/workers');
    const wallet = await fixture.open();
    const envelope = requested(fixture.input(wallet));
    const removeFailure = await injectSerializationFailure(wallet.id);
    const consumer = new SqsConsumer(fixture.finance, fixture.broker);
    await sendInput(JSON.stringify(envelope), wallet.id);
    try {
      // A one-second long poll may be empty while the two-second retry is
      // invisible. Observe exhausted delivery state rather than counting polls.
      await eventually(async () => {
        await consumer.runOnce();
        return await count('wager_transactions', "idempotency_key=$1 AND status='FAILED' AND failure_code='INFRASTRUCTURE_RETRY_EXHAUSTED'", [envelope.data.idempotencyKey]) === 1;
      }, 20_000, 'application retry budget exhaustion after real SQS deliveries');
      const messages = await collectMessages(fixture.broker.dlqUrl, message => message.Body === JSON.stringify(envelope), 1);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.MessageAttributes?.failureCode?.StringValue).toBe('INFRASTRUCTURE_RETRY_EXHAUSTED');
      expect(await fixture.finance.getProviderTransaction(envelope.data.providerId, envelope.data.externalTransactionId)).toMatchObject({ status: 'FAILED', failureCode: 'INFRASTRUCTURE_RETRY_EXHAUSTED' });
      expect(await count('inbox_messages', 'message_id=$1', [envelope.messageId])).toBe(0);
      expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('100.00');
    } finally { await removeFailure(); }
  }, 45_000);

  test('worker killed after commit recovers with three new processes and no duplicated debit/event', async () => {
    const wallet = await fixture.open();
    const input = fixture.input(wallet);
    const envelope = requested(input);
    const doomed = await fixture.spawn('worker', { TEST_CRASH_AFTER_COMMIT: '1' });
    await sendInput(JSON.stringify(envelope), wallet.id);
    const exitCode = await waitForExit(doomed, 20_000, 'worker death after commit');
    expect(exitCode).not.toBe(0);
    expect(doomed.child.signalCode === 'SIGKILL' || exitCode === 137).toBe(true);
    expect(await count('inbox_messages', 'message_id=$1', [envelope.messageId])).toBe(1);
    const [row] = await fixture.db.dataSource.query('SELECT id FROM wager_transactions WHERE idempotency_key=$1', [input.idempotencyKey]);
    expect(await count('wallet_ledger', 'transaction_id=$1', [row.id])).toBe(1);
    const recovery = await Promise.all([fixture.spawn('worker'), fixture.spawn('worker'), fixture.spawn('worker')]);
    try {
      await eventually(async () => {
        const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
        const response = await fixture.broker.client.send(new GetQueueAttributesCommand({ QueueUrl: fixture.broker.inputQueueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
        return response.Attributes?.ApproximateNumberOfMessages === '0' && response.Attributes?.ApproximateNumberOfMessagesNotVisible === '0'
          && await count('outbox_messages', "payload->'data'->>'transactionId'=$1 AND published_at IS NULL", [row.id]) === 0;
      }, 30_000, 'three-process recovery, source ack and outbox delivery');
      expect(await count('inbox_messages', 'message_id=$1', [envelope.messageId])).toBe(1);
      expect(await count('wallet_ledger', 'transaction_id=$1', [row.id])).toBe(1);
      expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
    } finally { await Promise.all(recovery.map(process => fixture.stop(process))); }
    // Restarting yet another application must read the committed state and replay its old result.
    const restarted = await fixture.spawn('api');
    try { expect((await postTransaction(restarted, input)).body).toMatchObject({ transactionId: row.id, idempotentReplay: true, balance: { amount: '75.00', currency: 'BRL' } }); }
    finally { await fixture.stop(restarted); }
    await fixture.assertConsistent();
  }, 75_000);
});

async function sendInput(body: string, group: string): Promise<void> {
  const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
  await fixture.broker.client.send(new SendMessageCommand({ QueueUrl: fixture.broker.inputQueueUrl, MessageBody: body, MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
}

async function collectMessages(queueUrl: string, accept: (message: Message) => boolean, expectedCount: number): Promise<Message[]> {
  const { ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
  const found: Message[] = [];
  await eventually(async () => {
    const response = await fixture.broker.client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }));
    for (const message of response.Messages ?? []) {
      if (accept(message)) found.push(message);
      await fixture.broker.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
    }
    return found.length >= expectedCount;
  }, 30_000, `receiving ${expectedCount} expected queue messages`);
  return found;
}

async function injectSerializationFailure(walletId: string): Promise<() => Promise<void>> {
  const name = `integration_serialization_${randomUUID().replaceAll('-', '')}`;
  await fixture.db.dataSource.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${walletId}'::uuid THEN RAISE EXCEPTION 'injected serialization failure' USING ERRCODE='40001'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  return async () => { await fixture.db.dataSource.query(`DROP TRIGGER ${name} ON wallets; DROP FUNCTION ${name}()`); };
}
