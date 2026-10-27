import { expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from 'typeorm';
import type { FinanceService } from '../../src/application/finance.service';
import type { Database } from '../../src/infra/database';
import { SqsBroker } from '../../src/infra/sqs';
import { config } from '../../src/config';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';
import { SqsConsumer } from '../../src/workers/sqs-consumer';

test('outbox normalizes the PostgreSQL UPDATE RETURNING tuple and publishes after claim commit', async () => {
  let inTransaction = false;
  const queries: string[] = [];
  const payload = { eventId: '8f932a1d-3acf-41d8-ae54-7729db75ec87', aggregateId: '0192f291-27dd-7d3f-8071-5f8685deef37', eventType: 'WalletBalanceChanged', data: {} };
  const row = { id: payload.eventId, aggregate_id: payload.aggregateId, payload, occurred_at: new Date(), attempts: 1, claim_token: 'token' };
  const db = { transaction: async (fn: (manager: EntityManager) => Promise<unknown>) => {
    inTransaction = true;
    try { return await fn({ query: async (sql: string) => { queries.push(sql); return sql.includes('WITH due') ? [[row], 1] : [[], 1]; } } as unknown as EntityManager); }
    finally { inTransaction = false; }
  } } as unknown as Database;
  const sent: unknown[] = [];
  const broker = { publishEvent: async (event: unknown) => { expect(inTransaction).toBe(false); sent.push(event); } } as unknown as SqsBroker;
  expect(await new OutboxPublisher(db, broker).runOnce()).toBe(1);
  expect(sent).toEqual([payload]);
  expect(queries.some(sql => sql.includes('published_at = now()') && sql.includes('claim_token = $2'))).toBe(true);
});

test('an empty PostgreSQL UPDATE RETURNING tuple makes no broker publication', async () => {
  const db = { transaction: async (fn: (manager: EntityManager) => Promise<unknown>) => fn({ query: async () => [[], 0] } as unknown as EntityManager) } as unknown as Database;
  const broker = { publishEvent: async () => { throw new Error('Empty outbox must not publish.'); } } as unknown as SqsBroker;
  expect(await new OutboxPublisher(db, broker).runOnce()).toBe(0);
});

test('shutdown returns unfinished messages to visibility before the process shutdown budget expires', async () => {
  const previousBudget = config.shutdownTimeoutMs;
  config.shutdownTimeoutMs = 100;
  let release!: () => void;
  let began!: () => void;
  let acknowledged!: () => void;
  const work = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { began = resolve; });
  const acked = new Promise<void>(resolve => { acknowledged = resolve; });
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const visibility: number[] = [];
  const message = {
    MessageId: 'sqs-message', ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '1' },
    Body: JSON.stringify({ messageId: 'domain-message', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00Z', data: {
      providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', walletId,
      roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
    } }),
  };
  const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === 'ReceiveMessageCommand') return { Messages: [message] };
    if (command.constructor.name === 'ChangeMessageVisibilityCommand') visibility.push(command.input.VisibilityTimeout as number);
    if (command.constructor.name === 'DeleteMessageCommand') acknowledged();
    return {};
  } } as unknown as SQSClient;
  const broker = new SqsBroker(client); broker.inputQueueUrl = 'input';
  const finance = { submit: async () => { began(); await work; return { transactionId: 'transaction', walletId, status: 'PROCESSED', balance: { amount: '0.00', currency: 'BRL' }, idempotentReplay: false }; } } as unknown as FinanceService;
  const consumer = new SqsConsumer(finance, broker);
  try {
    consumer.start(); await entered;
    await consumer.stop();
    expect(visibility).toEqual([0]);
    release(); await acked;
  } finally { release(); config.shutdownTimeoutMs = previousBudget; }
}, 5000);
