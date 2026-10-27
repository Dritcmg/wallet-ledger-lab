import { expect, test } from 'bun:test';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import type { FinanceService } from '../../src/application/finance.service';
import { SqsBroker } from '../../src/infra/sqs';
import { SqsConsumer } from '../../src/workers/sqs-consumer';

const receipt: Message = {
  ReceiptHandle: 'receipt', MessageId: 'delivery',
  Body: JSON.stringify({
    messageId: 'message', type: 'WagerTransactionRequested', occurredAt: '2026-01-01T00:00:00Z',
    data: {
      providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
    },
  }),
};

test('normal shutdown drains its poll and releases a late receipt without starting finance', async () => {
  let began!: () => void;
  let deliver!: (value: { Messages: Message[] }) => void;
  const entered = new Promise<void>(resolve => { began = resolve; });
  const response = new Promise<{ Messages: Message[] }>(resolve => { deliver = resolve; });
  const commands: { name: string; input: Record<string, unknown> }[] = [];
  let signal: AbortSignal | undefined;
  const broker = new SqsBroker({ send: (command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => {
    commands.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'ReceiveMessageCommand') {
      signal = options?.abortSignal;
      began();
      return response;
    }
    return Promise.resolve({});
  } } as unknown as SQSClient);
  broker.inputQueueUrl = 'input';
  let calls = 0;
  const finance = { submit: async () => { calls += 1; throw new Error('Finance must not start after shutdown.'); } } as unknown as FinanceService;
  const consumer = new SqsConsumer(finance, broker);
  consumer.start();
  await entered;
  const stopping = consumer.stop();
  deliver({ Messages: [receipt] });
  await stopping;
  expect(commands[0]!.input.WaitTimeSeconds).toBe(1);
  expect(signal?.aborted).toBe(false);
  expect(calls).toBe(0);
  expect(commands.map(command => command.name)).toEqual(['ReceiveMessageCommand', 'ChangeMessageVisibilityCommand']);
  expect(commands[1]!.input.VisibilityTimeout).toBe(0);
});

test('runOnce still processes a direct invocation without starting the background loop', async () => {
  const names: string[] = [];
  const broker = new SqsBroker({ send: async (command: { constructor: { name: string } }) => {
    names.push(command.constructor.name);
    return command.constructor.name === 'ReceiveMessageCommand' ? { Messages: [receipt] } : {};
  } } as unknown as SQSClient);
  broker.inputQueueUrl = 'input';
  let calls = 0;
  const finance = { submit: async () => {
    calls += 1;
    return { transactionId: 'transaction', walletId: 'wallet', status: 'PROCESSED', balance: { amount: '0.00', currency: 'BRL' }, idempotentReplay: false };
  } } as unknown as FinanceService;
  expect(await new SqsConsumer(finance, broker).runOnce()).toBe(1);
  expect(calls).toBe(1);
  expect(names).toEqual(['ReceiveMessageCommand', 'DeleteMessageCommand']);
});
