import { SqsBroker } from '../src/infra/sqs';
import { config } from '../src/config';

/** Explicit bootstrap entrypoint; normal startup only resolves existing queues. */
export async function setupQueues(): Promise<void> {
  const broker = new SqsBroker();
  try {
    await broker.provision();
    console.log(JSON.stringify({ level: 'info', event: 'queues_provisioned', queues: [config.queueName, config.dlqName, config.eventsQueueName] }));
  } finally {
    broker.close();
  }
}

if (import.meta.main) {
  setupQueues().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', event: 'queue_bootstrap_failed', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
