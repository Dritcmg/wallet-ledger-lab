import { expect, test } from 'bun:test';
import type { FinanceService } from '../../src/application/finance.service';
import { ApplicationError, type TransactionResult } from '../../src/application/contracts';
import type { Database } from '../../src/infra/database';
import type { SqsBroker } from '../../src/infra/sqs';
import { createApp } from '../../src/transport/app';
import { QueryFailedError, QueryRunnerAlreadyReleasedError } from 'typeorm';

test('Nest HTTP exposes stable status codes, explicit auth hooks, safe errors and separate health', async () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const money = { amount: '100.00', currency: 'BRL' };
  const result: TransactionResult = { transactionId: '0192f298-345e-7e38-af88-e43f851a819d', walletId, status: 'PROCESSED', balance: money, idempotentReplay: false };
  let authorized = 0;
  let ready = true;
  const db = { ping: async () => { if (!ready) throw new Error('postgresql://secret@internal'); } } as unknown as Database;
  const broker = { health: async () => {} } as unknown as SqsBroker;
  const finance = {
    openWallet: async () => ({ id: walletId, playerId, balance: money, version: 1 }),
    getWallet: async () => { throw new Error('SELECT private_data FROM passwords'); },
    submit: async (input: { externalTransactionId: string }) => {
      if (input.externalTransactionId === 'conflict') throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'Payload conflicts with an existing key.', 409);
      if (input.externalTransactionId === 'transient') throw Object.assign(new Error('Postgres hostname and credentials'), { code: '57P01' });
      return { ...result, status: input.externalTransactionId === 'rejected' ? 'REJECTED' : input.externalTransactionId === 'pending' ? 'PENDING_REFERENCE' : 'PROCESSED' };
    },
  } as unknown as FinanceService;
  const app = await createApp(db, finance, broker, { authorize: async () => { authorized++; } });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(authorized).toBe(0);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    ready = false;
    const unhealthy = await fetch(`${base}/health/ready`);
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.text()).not.toContain('secret');
    expect(authorized).toBe(0);

    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'provider:key', 'X-Correlation-Id': 'http-test' };
    const opened = await fetch(`${base}/wallets`, { method: 'POST', headers, body: JSON.stringify({ playerId, initialBalance: money }) });
    expect(opened.status).toBe(201);
    expect(opened.headers.get('X-Correlation-Id')).toBe('http-test');
    const data = { providerId: 'provider', externalTransactionId: 'processed', walletId, playerId, roundId: 'round', gameId: 'game', kind: 'BET', money };
    for (const [externalTransactionId, expected] of [['processed', 200], ['rejected', 422], ['pending', 202], ['conflict', 409], ['transient', 503]] as const) {
      const response = await fetch(`${base}/wagering/transactions`, { method: 'POST', headers, body: JSON.stringify({ ...data, externalTransactionId }) });
      expect(response.status).toBe(expected);
      expect(await response.text()).not.toContain('credentials');
    }
    const missingKey = await fetch(`${base}/wagering/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    expect(missingKey.status).toBe(400);
    const unknown = await fetch(`${base}/wagering/transactions`, { method: 'POST', headers, body: JSON.stringify({ ...data, unknown: true }) });
    expect(unknown.status).toBe(400);
    const failedQuery = await fetch(`${base}/wallets/${walletId}`);
    expect(failedQuery.status).toBe(500);
    expect(await failedQuery.text()).not.toContain('passwords');
    const invalidId = await fetch(`${base}/wallets/invalid`);
    expect(invalidId.status).toBe(400);
    const malformed = await fetch(`${base}/wallets`, { method: 'POST', headers, body: '{' });
    expect(malformed.status).toBe(400);
    const tooLarge = await fetch(`${base}/wallets`, { method: 'POST', headers, body: JSON.stringify({ playerId: 'x'.repeat(65536) }) });
    expect(tooLarge.status).toBe(413);
    const metrics = await fetch(`${base}/metrics`);
    expect(await metrics.text()).toContain('wager_http_requests_total');
    expect(authorized).toBeGreaterThan(0);
  } finally { await app.close(); }
}, 10000);

test.each([
  ['55P03', () => new QueryFailedError('SELECT private_data FROM passwords', [], Object.assign(new Error('private connection credentials'), { code: '55P03' }))],
  ['57014', () => Object.assign(new Error('private connection credentials'), { driverError: { code: '57014' } })],
  ['released query runner', () => new QueryRunnerAlreadyReleasedError()],
  ['pool connection timeout', () => new Error('timeout exceeded when trying to connect')],
] as const)('HTTP treats %s as transient infrastructure failure without exposing driver details', async (_scenario, failure) => {
  const finance = { submit: async () => { throw failure(); } } as unknown as FinanceService;
  const app = await createApp({} as Database, finance, {} as SqsBroker);
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/wagering/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'provider:retry' },
      body: JSON.stringify({ providerId: 'provider', externalTransactionId: 'retry',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37', playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }),
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe('INFRASTRUCTURE_UNAVAILABLE');
    expect(body).not.toContain('private');
    expect(body).not.toContain('passwords');
    expect(body).not.toContain('credentials');
  } finally { await app.close(); }
}, 10000);
