import { Database } from '../../src/infra/database';
import { SqsBroker, type PublishableEvent } from '../../src/infra/sqs';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';

const destination = new URL(process.env.DATABASE_URL ?? '');
if (process.env.NODE_ENV !== 'test' || process.env.TEST_PUBLISHER_CRASH !== '1'
  || destination.pathname !== '/wager_test'
  || !['localhost', '127.0.0.1', '[::1]', 'postgres-test'].includes(destination.hostname)) {
  throw new Error('Publisher crash fixture requires the explicit flag and dedicated local test database.');
}

// Fault injection happens after the real publisher commits its SQL claim and
// before its first SDK send. The database and broker remain the real adapters.
class CrashBeforeSendBroker extends SqsBroker {
  override async publishEvent(event: PublishableEvent): Promise<void> {
    console.log(JSON.stringify({ event: 'publisher_claim_committed_before_crash', eventId: event.eventId }));
    process.kill(process.pid, 'SIGKILL');
  }
}

const database = new Database();
const broker = new CrashBeforeSendBroker();
try {
  await database.initialize();
  await broker.initialize();
  const claimed = await new OutboxPublisher(database, broker).runOnce();
  if (claimed === 0) throw new Error('Crash fixture did not find a due event to claim.');
  throw new Error('Crash fixture unexpectedly survived the injected SIGKILL.');
} finally {
  broker.close();
  await database.close();
}
