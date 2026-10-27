import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { IntegrationFixture, postTransaction, sqlFailure } from './fixtures';

let fixture: IntegrationFixture;
beforeAll(async () => { fixture = await IntegrationFixture.initialize(); await fixture.startApis(); }, 60000);
afterAll(async () => { if (fixture) await fixture.close(); }, 30000);

describe('Financial edge contracts verified through real persistence', () => {
  test('TRUNCATE cannot remove ledger or transaction audit, even through CASCADE', async () => {
    const wallet = await fixture.open();
    for (const statement of ['TRUNCATE wallet_ledger', 'TRUNCATE wager_transactions CASCADE']) {
      // An unconditional rollback also protects test fixtures if the guard regresses.
      await sqlFailure(async () => {
        const runner = fixture.db.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try { await runner.query(statement); }
        finally { await runner.rollbackTransaction(); await runner.release(); }
      }, '55000');
    }
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('100.00');
    const [row] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM wallet_ledger WHERE wallet_id=$1', [wallet.id]);
    expect(row.n).toBe(1);
    await fixture.assertConsistent();
  });
  test('another idempotency key cannot reapply an external operation', async () => {
    const wallet = await fixture.open();
    const input = fixture.input(wallet);
    expect((await postTransaction(fixture.apis[0]!, input)).status).toBe(200);
    const conflict = await postTransaction(fixture.apis[1]!, { ...input, idempotencyKey: `another:${randomUUID()}` });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: 'EXTERNAL_TRANSACTION_CONFLICT' } });
    const replay = await postTransaction(fixture.apis[2]!, { ...input, money: { amount: '00025.00', currency: 'BRL' } });
    expect(replay.body).toMatchObject({ idempotentReplay: true, balance: { amount: '75.00' } });
    expect((await fixture.finance.getWallet(wallet.id)).balance.amount).toBe('75.00');
  });

  test('different concurrent refunds of one bet produce one credit and an audited rejection', async () => {
    const wallet = await fixture.open();
    const bet = fixture.input(wallet);
    const accepted = await postTransaction(fixture.apis[0]!, bet);
    expect(accepted.body.status).toBe('PROCESSED');
    const refunds = [0, 1].map(() => {
      const id = randomUUID();
      return { ...bet, externalTransactionId: id, idempotencyKey: `refund:${id}`, kind: 'REFUND' as const,
        referenceExternalTransactionId: bet.externalTransactionId };
    });
    const replies = await Promise.all(refunds.map((input, i) => postTransaction(fixture.apis[i + 1]!, input)));
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 422]);
    expect(replies.find(reply => reply.body.status === 'REJECTED')!.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const [totals] = await fixture.db.dataSource.query(`SELECT count(*)::integer AS n FROM wallet_ledger
      WHERE transaction_id=ANY($1::uuid[])`, [replies.map(reply => reply.body.transactionId)]);
    expect(totals.n).toBe(1);
    expect(await fixture.finance.getWallet(wallet.id)).toMatchObject({ balance: { amount: '100.00' }, version: 3 });
    await fixture.assertConsistent();
  });

  test('PostgreSQL preserves the monetary boundary exactly and an overflowing credit is rejected without mutation', async () => {
    const maximum = `${'9'.repeat(36)}.99`;
    const wallet = await fixture.open(maximum);
    const [stored] = await fixture.db.dataSource.query('SELECT balance::text AS amount FROM wallets WHERE id=$1', [wallet.id]);
    expect(stored.amount).toBe(maximum);
    const result = await postTransaction(fixture.apis[0]!, fixture.input(wallet, { kind: 'WIN', money: { amount: '0.01', currency: 'BRL' } }));
    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe('MONEY_OVERFLOW');
    expect(await fixture.finance.getWallet(wallet.id)).toMatchObject({ balance: { amount: maximum }, version: 1 });
    const [totals] = await fixture.db.dataSource.query('SELECT count(*)::integer AS n FROM wallet_ledger WHERE wallet_id=$1', [wallet.id]);
    expect(totals.n).toBe(1);
    await fixture.assertConsistent();
  });

  test('reference TTL expires before the attempt budget and zero LOSS changes no balance or version', async () => {
    const { config } = await import('../../src/config');
    const previousTtl = config.referenceTtlSeconds;
    const previousAttempts = config.referenceMaxAttempts;
    config.referenceTtlSeconds = 1;
    config.referenceMaxAttempts = 100;
    try {
      const wallet = await fixture.open();
      const pending = await fixture.finance.submit(fixture.input(wallet, { kind: 'REFUND', referenceExternalTransactionId: randomUUID() }));
      expect(pending.status).toBe('PENDING_REFERENCE');
      await Bun.sleep(1100);
      await fixture.finance.retryPendingReferences(1000);
      expect(await fixture.finance.getTransaction(pending.transactionId)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
      const [row] = await fixture.db.dataSource.query('SELECT attempts FROM wager_transactions WHERE id=$1', [pending.transactionId]);
      expect(row.attempts).toBe(1);
      const loss = await fixture.finance.submit(fixture.input(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }));
      expect(loss.status).toBe('PROCESSED');
      expect(await fixture.finance.getWallet(wallet.id)).toMatchObject({ balance: { amount: '100.00' }, version: 1 });
      await fixture.assertConsistent();
    } finally {
      config.referenceTtlSeconds = previousTtl;
      config.referenceMaxAttempts = previousAttempts;
    }
  });
});
