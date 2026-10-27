import {
  ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { ApplicationError, type TransactionResult } from '../application/contracts';
import { FinanceService } from '../application/finance.service';
import { sha256 } from '../application/hash';
import { config } from '../config';
import { DomainError } from '../domain/errors';
import { logger, metrics } from '../infra/observability';
import { SqsBroker } from '../infra/sqs';
import { parseRequestedMessage, type RequestedMessage } from '../transport/validation';
import { backoffSeconds, drain } from './lifecycle';

export interface ConsumerHooks { afterCommit?: (result: TransactionResult, message: RequestedMessage) => Promise<void> }
export class SqsConsumer {
  private running = false;
  private stopping = false;
  private task?: Promise<void>;
  private pollAbort?: AbortController;
  private readonly inFlight = new Map<string, Message>();
  private readonly visibilityTimers = new Map<string, ReturnType<typeof setInterval>>();
  readonly consumerName = 'wager-transactions-v1';

  constructor(private readonly finance: FinanceService, private readonly broker: SqsBroker, private readonly hooks: ConsumerHooks = {}) {}

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = true;
    this.task = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try { await this.runOnce(); }
      catch {
        if (!this.running) break;
        logger.error('sqs_receive_failed', { worker: 'sqs', code: 'BROKER_UNAVAILABLE' });
        await new Promise(resolve => setTimeout(resolve, config.workerIntervalMs));
      }
    }
  }

  async runOnce(): Promise<number> {
    const pollAbort = new AbortController();
    this.pollAbort = pollAbort;
    // A one-second poll costs more idle requests, but normally drains inside the
    // shutdown budget. Aborting a longer client poll can leave server-side
    // receives that spend another delivery's redrive budget after shutdown.
    const response = await this.broker.client.send(new ReceiveMessageCommand({
      QueueUrl: this.broker.inputQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
      VisibilityTimeout: config.sqsVisibilitySeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }), { abortSignal: pollAbort.signal }).finally(() => {
      if (this.pollAbort === pollAbort) this.pollAbort = undefined;
    });
    const messages = response.Messages ?? [];
    if (this.stopping) {
      // A receive that completed during shutdown must hand its receipts back,
      // rather than starting financial work after the drain has begun.
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(config.shutdownTimeoutMs * 0.2)));
      await Promise.allSettled(messages.filter(message => message.ReceiptHandle)
        .map(message => this.visibility(message.ReceiptHandle!, 0, signal)));
      return messages.length;
    }
    const outcomes = await Promise.allSettled(messages.map(message => this.processMessage(message)));
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('SQS message acknowledgement or persistence unavailable.');
    return messages.length;
  }

  async processMessage(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (!receipt) return;
    this.inFlight.set(receipt, message);
    const heartbeat = setInterval(() => {
      void this.visibility(receipt, config.sqsVisibilitySeconds).catch(() => {
        logger.error('sqs_visibility_renewal_failed', { messageId: message.MessageId, code: 'BROKER_UNAVAILABLE' });
      });
    }, Math.max(250, Math.floor(config.sqsVisibilitySeconds * 1000 / 3)));
    this.visibilityTimers.set(receipt, heartbeat);
    const started = performance.now();
    let requested: RequestedMessage | undefined;
    try {
      try { requested = parseRequestedMessage(message.Body ?? ''); }
      catch { await this.deadLetter(message, 'INVALID_MESSAGE_CONTRACT'); return; }

      const context = {
        correlationId: requested.correlationId ?? requested.messageId,
        inbox: { consumerName: this.consumerName, messageId: requested.messageId, payloadHash: sha256(requested.data) },
      };
      const result = await this.finance.submit(requested.data, context);
      // FinanceService resolves only after its inbox/financial/outbox SQL transaction commits.
      await this.hooks.afterCommit?.(result, requested);
      if (config.testCrashAfterCommit) process.kill(process.pid, 'SIGKILL');
      await this.ack(receipt);
      logger.info('sqs_transaction_committed', {
        correlationId: context.correlationId, messageId: requested.messageId,
        transactionId: result.transactionId, walletId: requested.data.walletId,
        providerId: requested.data.providerId, status: result.status,
      });
    } catch (error) {
      const attempt = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? 1) || 1);
      const permanent = error instanceof DomainError || (error instanceof ApplicationError && error.httpStatus < 500);
      if (permanent) {
        await this.deadLetter(message, error.code);
      } else if (attempt >= config.sqsMaxAttempts) {
        // Existing PENDING rows become auditably FAILED before the broker message is acknowledged.
        if (requested) await this.finance.failPendingTransaction(requested.data, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
        await this.deadLetter(message, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
      } else {
        const delaySeconds = backoffSeconds(attempt);
        await this.visibility(receipt, delaySeconds);
        metrics.increment('wager_retries_total', { worker: 'sqs' });
        logger.error('sqs_transaction_retry', {
          correlationId: requested?.correlationId ?? requested?.messageId, messageId: requested?.messageId ?? message.MessageId,
          walletId: requested?.data.walletId, providerId: requested?.data.providerId,
          attempt, delaySeconds, code: 'TRANSIENT_PROCESSING_FAILURE',
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.visibilityTimers.delete(receipt);
      this.inFlight.delete(receipt);
      metrics.observe('wager_sqs_processing_duration_seconds', (performance.now() - started) / 1000);
    }
  }

  private visibility(receipt: string, seconds: number, abortSignal?: AbortSignal): Promise<unknown> {
    return this.broker.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.broker.inputQueueUrl, ReceiptHandle: receipt, VisibilityTimeout: seconds }), { abortSignal });
  }
  private ack(receipt: string): Promise<unknown> {
    return this.broker.client.send(new DeleteMessageCommand({ QueueUrl: this.broker.inputQueueUrl, ReceiptHandle: receipt }));
  }
  private async deadLetter(message: Message, code: string): Promise<void> {
    await this.broker.client.send(new SendMessageCommand({
      QueueUrl: this.broker.dlqUrl, MessageBody: message.Body || '{}',
      MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid-contract',
      MessageDeduplicationId: sha256({ sourceMessageId: message.MessageId ?? message.Body }),
      MessageAttributes: { failureCode: { DataType: 'String', StringValue: code } },
    }));
    // A crash between send and delete may duplicate DLQ delivery; business idempotency remains SQL-backed.
    await this.ack(message.ReceiptHandle!);
    metrics.increment('wager_dlq_messages_total', { code });
    logger.error('sqs_message_dead_lettered', { messageId: message.MessageId, code });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    const drained = !this.task || await drain(this.task, Math.max(1, Math.floor(config.shutdownTimeoutMs * 0.7)));
    if (!drained) this.pollAbort?.abort();
    if (!drained || this.inFlight.size) {
      for (const timer of this.visibilityTimers.values()) clearInterval(timer);
      this.visibilityTimers.clear();
      const abortSignal = AbortSignal.timeout(Math.max(1, Math.floor(config.shutdownTimeoutMs * 0.2)));
      await Promise.allSettled([...this.inFlight.keys()].map(receipt => this.visibility(receipt, 0, abortSignal)));
      logger.info('sqs_inflight_released', { count: this.inFlight.size });
    }
  }
}
