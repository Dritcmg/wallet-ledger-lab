export { SqsConsumer, type ConsumerHooks } from './sqs-consumer';
export { OutboxPublisher } from './outbox-publisher';
export { PendingReferenceWorker } from './pending-reference';

import { SqsConsumer } from './sqs-consumer';
import { OutboxPublisher } from './outbox-publisher';
import { PendingReferenceWorker } from './pending-reference';

export class WorkerSupervisor {
  constructor(readonly consumer: SqsConsumer, readonly outbox: OutboxPublisher, readonly references: PendingReferenceWorker) {}
  start(): void { this.consumer.start(); this.outbox.start(); this.references.start(); }
  async stop(): Promise<void> { await Promise.all([this.consumer.stop(), this.outbox.stop(), this.references.stop()]); }
}
