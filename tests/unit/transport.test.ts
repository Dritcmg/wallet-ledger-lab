import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { FinanceService } from '../../src/application/finance.service';
import type { TransactionResult } from '../../src/application/contracts';
import { ApplicationError } from '../../src/application/contracts';
import { sha256 } from '../../src/application/hash';
import { DomainError } from '../../src/domain/errors';
import { SqsBroker } from '../../src/infra/sqs';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { parseLedgerQuery, parseOpenWallet, parseRequestedMessage, parseSubmit } from '../../src/transport/validation';

const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const data = {
  providerId: 'provider-a', externalTransactionId: 'transaction-123', playerId, walletId,
  roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
};
const requested = { messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data: { ...data, idempotencyKey: 'provider-a:transaction-123' } };
const result: TransactionResult = { transactionId: '0192f298-345e-7e38-af88-e43f851a819d', walletId, status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false };

describe('public transport contracts', () => {
  test('requires the HTTP header and rejects a competing idempotency field in the body', () => {
    expect(() => parseSubmit(data)).toThrow(ApplicationError);
    expect(() => parseSubmit({ ...data, idempotencyKey: 'body-key' }, 'header-key')).toThrow(ApplicationError);
    expect(parseSubmit(data, 'header-key').idempotencyKey).toBe('header-key');
  });
  test('rejects unknown fields, OPENING, numeric money and excess precision', () => {
    for (const input of [
      { ...data, admin: true }, { ...data, kind: 'OPENING' },
      { ...data, money: { amount: 25, currency: 'BRL' } },
      { ...data, money: { amount: '25.001', currency: 'BRL' } },
      { ...data, money: { amount: '25.00', currency: 'BRL', scale: 2 } },
    ]) expect(() => parseSubmit(input, 'key')).toThrow();
  });
  test('wallet opening and references require valid explicit fields', () => {
    expect(parseOpenWallet({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } }).initialBalance.amount).toBe('0.00');
    expect(() => parseOpenWallet({ playerId: 'invalid', initialBalance: data.money })).toThrow();
    expect(() => parseSubmit({ ...data, kind: 'REFUND' }, 'key')).toThrow();
  });
  test('rejects malformed envelopes, invalid kinds and timestamps', () => {
    expect(parseRequestedMessage(JSON.stringify(requested)).data.idempotencyKey).toBe('provider-a:transaction-123');
    expect(() => parseRequestedMessage('{')).toThrow();
    expect(() => parseRequestedMessage(JSON.stringify({ ...requested, type: 'Other' }))).toThrow();
    expect(() => parseRequestedMessage(JSON.stringify({ ...requested, occurredAt: 'yesterday' }))).toThrow();
  });
  test('pagination accepts opaque cursors and bounds page sizes', () => {
    expect(parseLedgerQuery({})).toEqual({ cursor: undefined, limit: 50 });
    expect(parseLedgerQuery({ cursor: 'YWJj', limit: '100' }).limit).toBe(100);
    for (const query of [{ limit: '101' }, { limit: '0' }, { limit: ['1', '2'] }, { cursor: '../secrets' }, { offset: '1' }]) {
      expect(() => parseLedgerQuery(query)).toThrow();
    }
  });
});

function consumerHarness(finance: Partial<FinanceService>, hooks = {}) {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    commands.push({ name: command.constructor.name, input: command.input }); return {};
  } } as unknown as SQSClient;
  const broker = new SqsBroker(client);
  broker.inputQueueUrl = 'input'; broker.dlqUrl = 'dlq'; broker.eventsQueueUrl = 'events';
  const consumer = new SqsConsumer(finance as FinanceService, broker, hooks);
  const message = { MessageId: 'sqs-id', ReceiptHandle: 'receipt', Body: JSON.stringify(requested), Attributes: { ApproximateReceiveCount: '1', MessageGroupId: walletId } };
  return { commands, consumer, message };
}

describe('SQS transaction boundary', () => {
  test('acknowledges only after the shared use case commits and carries canonical inbox data', async () => {
    let release!: () => void;
    let entered!: () => void;
    const committed = new Promise<void>(resolve => { entered = resolve; });
    const afterCommit = new Promise<void>(resolve => { release = resolve; });
    const harness = consumerHarness({ submit: async (_input, context) => {
      expect(context?.inbox?.messageId).toBe(requested.messageId);
      expect(context?.inbox?.payloadHash).toBe(sha256(requested.data));
      return result;
    } }, { afterCommit: async () => { entered(); await afterCommit; } });
    const processing = harness.consumer.processMessage(harness.message);
    await committed;
    expect(harness.commands.some(command => command.name === 'DeleteMessageCommand')).toBe(false);
    release(); await processing;
    expect(harness.commands.map(command => command.name)).toEqual(['DeleteMessageCommand']);
  });
  test('a transient failure changes visibility and leaves the source message unacknowledged', async () => {
    const harness = consumerHarness({ submit: async () => { throw new Error('Database temporarily unavailable'); } });
    await harness.consumer.processMessage(harness.message);
    expect(harness.commands.map(command => command.name)).toEqual(['ChangeMessageVisibilityCommand']);
    expect(harness.commands[0]!.input.VisibilityTimeout).toBe(1);
  });
  test('invalid envelopes reach the DLQ before source acknowledgement', async () => {
    const harness = consumerHarness({ submit: async () => { throw new Error('Must never submit invalid contracts'); } });
    await harness.consumer.processMessage({ ...harness.message, Body: '{invalid' });
    expect(harness.commands.map(command => command.name)).toEqual(['SendMessageCommand', 'DeleteMessageCommand']);
    expect(harness.commands[0]!.input.QueueUrl).toBe('dlq');
  });
  test('a rejected transaction is terminal and acknowledged without retry', async () => {
    const harness = consumerHarness({ submit: async () => ({ ...result, status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' }) });
    await harness.consumer.processMessage(harness.message);
    expect(harness.commands.map(command => command.name)).toEqual(['DeleteMessageCommand']);
  });
  test('an idempotency conflict is a permanent message failure', async () => {
    const harness = consumerHarness({ submit: async () => { throw new DomainError('IDEMPOTENCY_CONFLICT', 'Conflicting payload'); } });
    await harness.consumer.processMessage(harness.message);
    expect(harness.commands.map(command => command.name)).toEqual(['SendMessageCommand', 'DeleteMessageCommand']);
  });
});
