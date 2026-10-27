import { Database } from './infra/database';
import { SqsBroker } from './infra/sqs';
import { logger } from './infra/observability';
import { FinanceService } from './application/finance.service';
import { createApp } from './transport/app';
import { SqsConsumer, OutboxPublisher, PendingReferenceWorker, WorkerSupervisor } from './workers';
import { config } from './config';

if (!['api', 'worker', 'all'].includes(config.role)) throw new Error('APP_ROLE must be api, worker or all');
const db = new Database();
const broker = new SqsBroker();
let closing = false;
try {
  await db.initialize();
  await broker.initialize();
  const finance = new FinanceService(db);
  const app = await createApp(db, finance, broker);
  const workers = config.role === 'api' ? undefined : new WorkerSupervisor(
    new SqsConsumer(finance, broker), new OutboxPublisher(db, broker), new PendingReferenceWorker(finance),
  );
  await app.listen(config.port, config.bindHost);
  workers?.start();
  logger.info('service_started', { port: config.port, role: config.role });

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    logger.info('shutdown_started', { role: config.role });
    const deadline = setTimeout(() => {
      logger.error('shutdown_deadline_exceeded', { role: config.role });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    try {
      await Promise.all([app.close(), workers?.stop()]);
      broker.close();
      await db.close();
      clearTimeout(deadline);
      logger.info('shutdown_completed', { role: config.role });
    } catch {
      clearTimeout(deadline);
      logger.error('shutdown_failed', { role: config.role });
      process.exitCode = 1;
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  logger.error('startup_failed', { role: config.role });
  broker.close();
  await db.close();
  process.exitCode = 1;
}
