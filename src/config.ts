// Keep fault-injection switches runtime-only: Bun otherwise folds direct
// process.env.NODE_ENV access and produces a different test bundle.
const runtimeEnvironment = process.env;

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
export const config = {
  testCrashAfterCommit: runtimeEnvironment.NODE_ENV === 'test' && runtimeEnvironment.TEST_CRASH_AFTER_COMMIT === '1',
  port: positiveInteger('PORT', 3000),
  bindHost: process.env.BIND_HOST ?? '127.0.0.1',
  role: process.env.APP_ROLE ?? 'all',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://wager:development-placeholder@localhost:55442/wager',
  sqsEndpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4576',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  queueName: 'wager-transactions.fifo',
  dlqName: 'wager-transactions-dlq.fifo',
  eventsQueueName: 'wager-events.fifo',
  sqsVisibilitySeconds: positiveInteger('SQS_VISIBILITY_SECONDS', 30),
  sqsMaxAttempts: positiveInteger('SQS_MAX_ATTEMPTS', 5),
  referenceMaxAttempts: positiveInteger('REFERENCE_MAX_ATTEMPTS', 8),
  referenceTtlSeconds: positiveInteger('REFERENCE_TTL_SECONDS', 3600),
  referenceRetryBaseMs: positiveInteger('REFERENCE_RETRY_BASE_MS', 1000),
  outboxLeaseSeconds: positiveInteger('OUTBOX_LEASE_SECONDS', 30),
  workerIntervalMs: positiveInteger('WORKER_INTERVAL_MS', 300),
  shutdownTimeoutMs: positiveInteger('SHUTDOWN_TIMEOUT_MS', 10000),
};
