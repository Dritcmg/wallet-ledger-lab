import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { Initial1730000000000 } from '../../src/infra/migrations/1730000000000-Initial';
import { AuditGuards1730000001000 } from '../../src/infra/migrations/1730000001000-AuditGuards';
import { FinancialGuards1730000002000 } from '../../src/infra/migrations/1730000002000-FinancialGuards';
import { IntegrationFixture, sqlFailure } from './fixtures';

let fixture: IntegrationFixture;
beforeAll(async () => { fixture = await IntegrationFixture.initialize(); }, 60_000);
afterAll(async () => { if (fixture) await fixture.close(); }, 30_000);

interface WalletIds { id: string; playerId: string }
interface Posting { amount: string; before: string; after: string; version: number }

// All fixtures and attempted violations are rolled back, including a guard that unexpectedly accepts them.
async function rolledBack(operation: (manager: EntityManager) => Promise<void>): Promise<void> {
  const rollback = new Error('Discard synthetic schema review transaction');
  try {
    await fixture.db.transaction(async manager => { await operation(manager); throw rollback; });
  } catch (error) { if (error !== rollback) throw error; }
}

async function wallet(manager: EntityManager, balance = '100.00', version = 1): Promise<WalletIds> {
  const ids = { id: randomUUID(), playerId: randomUUID() };
  await manager.query(`INSERT INTO wallets(id,player_id,currency,balance,version,created_at,updated_at)
    VALUES($1,$2,'BRL',$3,$4,now(),now())`, [ids.id, ids.playerId, balance, version]);
  return ids;
}

async function transaction(manager: EntityManager, owner: WalletIds, kind: 'OPENING' | 'WIN' | 'BET', amount: string, balance: string, status = 'PROCESSED'): Promise<string> {
  const id = randomUUID();
  await manager.query(`INSERT INTO wager_transactions
    (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,
      kind,amount,currency,status,result_balance,result_currency,processed_at,created_at)
    VALUES($1::uuid,$2,$1::text,$3,$4,$5,$6,'schema-review','schema-review',$7,$8,'BRL',$9,$10,'BRL',$11,now())`,
    [id, `review:${owner.id}`, `review:${id}`, 'f'.repeat(64), owner.id, owner.playerId, kind, amount, status, balance,
      status === 'PROCESSED' ? new Date() : null]);
  return id;
}

async function ledger(manager: EntityManager, owner: WalletIds, transactionId: string, posting: Posting): Promise<void> {
  await manager.query(`INSERT INTO wallet_ledger
    (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at)
    VALUES($1,$2,$3,'CREDIT',$4,'BRL',$5,$6,$7,now())`,
    [randomUUID(), owner.id, transactionId, posting.amount, posting.before, posting.after, posting.version]);
}

async function opened(manager: EntityManager): Promise<WalletIds> {
  const owner = await wallet(manager);
  const id = await transaction(manager, owner, 'OPENING', '100.00', '100.00');
  await ledger(manager, owner, id, { amount: '100.00', before: '0.00', after: '100.00', version: 1 });
  return owner;
}

async function finiteViolation(operation: (manager: EntityManager, owner: WalletIds) => Promise<void>, constraint: string): Promise<void> {
  let failure: unknown;
  try { await rolledBack(async manager => { const owner = await opened(manager); await operation(manager, owner); await manager.query('SET CONSTRAINTS ALL IMMEDIATE'); }); }
  catch (error) { failure = error; }
  const driver = (failure as { driverError?: { code?: string; constraint?: string } } | undefined)?.driverError;
  expect(driver?.code).toBe('23514');
  expect(driver?.constraint).toBe(constraint);
}

describe('Finite monetary values enforced by real PostgreSQL', () => {
  test('wallet balance rejects numeric NaN', async () => {
    await finiteViolation((manager, owner) => manager.query("UPDATE wallets SET balance='NaN',version=version+1 WHERE id=$1", [owner.id]), 'wallets_balance_finite');
  });

  test('transaction amount rejects numeric NaN', async () => {
    await finiteViolation(async (manager, owner) => { await transaction(manager, owner, 'BET', 'NaN', '100.00', 'PENDING'); }, 'transactions_amount_finite');
  });

  test('transaction result balance rejects numeric NaN', async () => {
    await finiteViolation(async (manager, owner) => { await transaction(manager, owner, 'BET', '1.00', 'NaN', 'PENDING'); }, 'transactions_result_balance_finite');
  });

  test.each([
    ['amount', { amount: 'NaN', before: '0.00', after: '0.00', version: 2 }, 'ledger_amount_finite'],
    ['balance before', { amount: '1.00', before: 'NaN', after: '1.00', version: 2 }, 'ledger_balance_before_finite'],
    ['balance after', { amount: '1.00', before: '0.00', after: 'NaN', version: 2 }, 'ledger_balance_after_finite'],
  ] as const)('ledger %s rejects numeric NaN', async (_column, posting, constraint) => {
    await finiteViolation(async (manager, owner) => {
      const id = await transaction(manager, owner, 'WIN', '1.00', '1.00');
      await ledger(manager, owner, id, posting);
    }, constraint);
  });
});

describe('Continuous monetary history enforced at the deferred transaction boundary', () => {
  test('rejects a discontinuous before/after snapshot even when the global ledger sum matches', async () => {
    await sqlFailure(() => rolledBack(async manager => {
      const owner = await opened(manager);
      const id = await transaction(manager, owner, 'WIN', '10.00', '10.00');
      await manager.query('UPDATE wallets SET balance=110,version=2 WHERE id=$1', [owner.id]);
      await ledger(manager, owner, id, { amount: '10.00', before: '0.00', after: '10.00', version: 2 });
      await manager.query('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');
  });

  test('rejects missing ledger versions even when the final version, balance and arithmetic match', async () => {
    await sqlFailure(() => rolledBack(async manager => {
      const owner = await opened(manager);
      const id = await transaction(manager, owner, 'WIN', '10.00', '110.00');
      await manager.query('UPDATE wallets SET balance=105,version=2 WHERE id=$1', [owner.id]);
      await manager.query('UPDATE wallets SET balance=110,version=3 WHERE id=$1', [owner.id]);
      await ledger(manager, owner, id, { amount: '10.00', before: '100.00', after: '110.00', version: 3 });
      await manager.query('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');
  });

  test('rejects an OPENING assigned to the first version after a zero wallet', async () => {
    await sqlFailure(() => rolledBack(async manager => {
      const owner = await wallet(manager, '0.00');
      const id = await transaction(manager, owner, 'OPENING', '10.00', '10.00');
      await manager.query('UPDATE wallets SET balance=10,version=2 WHERE id=$1', [owner.id]);
      await ledger(manager, owner, id, { amount: '10.00', before: '0.00', after: '10.00', version: 2 });
      await manager.query('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');
  });

  test('an empty ledger requires zero balance and initial version one', async () => {
    await rolledBack(async manager => { await wallet(manager, '0.00'); await manager.query('SET CONSTRAINTS ALL IMMEDIATE'); });
    await sqlFailure(() => rolledBack(async manager => { await wallet(manager, '0.00', 2); await manager.query('SET CONSTRAINTS ALL IMMEDIATE'); }), '23514');
  });

  test('accepts a positive opening followed by a matching credit', async () => {
    await rolledBack(async manager => {
      const owner = await opened(manager);
      const id = await transaction(manager, owner, 'WIN', '10.00', '110.00');
      await manager.query('UPDATE wallets SET balance=110,version=2 WHERE id=$1', [owner.id]);
      await ledger(manager, owner, id, { amount: '10.00', before: '100.00', after: '110.00', version: 2 });
      await manager.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  test('accepts a first credit at version two when the wallet opened with zero', async () => {
    await rolledBack(async manager => {
      const owner = await wallet(manager, '0.00');
      const id = await transaction(manager, owner, 'WIN', '10.00', '10.00');
      await manager.query('UPDATE wallets SET balance=10,version=2 WHERE id=$1', [owner.id]);
      await ledger(manager, owner, id, { amount: '10.00', before: '0.00', after: '10.00', version: 2 });
      await manager.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });
});

test('all three migrations reverse and reapply in a rolled-back isolated schema; financial down retains rows', async () => {
  const name = `financial_review_${randomUUID().replaceAll('-', '')}`;
  const runner = fixture.db.dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query(`CREATE SCHEMA ${name}`);
    await runner.query(`SET LOCAL search_path TO ${name}`);
    const migrations = [new Initial1730000000000(), new AuditGuards1730000001000(), new FinancialGuards1730000002000()];
    for (const migration of migrations) await migration.up(runner);
    const owner = await wallet(runner.manager, '0.00');
    await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
    await migrations[2]!.down(runner);
    let [row] = await runner.query('SELECT count(*)::int AS n FROM wallets WHERE id=$1', [owner.id]);
    expect(row.n).toBe(1);
    await migrations[2]!.up(runner);
    [row] = await runner.query('SELECT count(*)::int AS n FROM wallets WHERE id=$1', [owner.id]);
    expect(row.n).toBe(1);
    for (const migration of [...migrations].reverse()) await migration.down(runner);
    [row] = await runner.query("SELECT to_regclass('wallets')::text AS name");
    expect(row.name).toBeNull();
    for (const migration of migrations) await migration.up(runner);
    [row] = await runner.query("SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname LIKE '%_finite'");
    expect(row.n).toBe(6);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
}, 30_000);
