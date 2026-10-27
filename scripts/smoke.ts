import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../src/config';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'app', 'localstack', 'localstack-test']);
const baseUrl = new URL(process.env.APP_BASE_URL ?? 'http://localhost:3100');
for (const endpoint of [baseUrl, new URL(config.sqsEndpoint)]) {
  if (!localHosts.has(endpoint.hostname)) throw new Error('Smoke fixtures are restricted to local endpoints.');
}

type JsonObject = Record<string, unknown>;
type Transaction = { transactionId: string; status: string; idempotentReplay: boolean; balance: { amount: string; currency: string } };
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function request(path: string, init?: RequestInit): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(10000) });
  const body: unknown = await response.json();
  assert(body !== null && typeof body === 'object' && !Array.isArray(body), `Unexpected response shape from ${path}.`);
  return { status: response.status, body: body as JsonObject };
}
function post(path: string, body: unknown, key?: string) {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
}
async function eventually(probe: () => Promise<boolean>, description: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function smoke(): Promise<void> {
  for (const path of ['/health/live', '/health/ready']) {
    const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(10000) });
    assert(response.ok, `${path} returned HTTP ${response.status}.`);
  }
  const fixtureId = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  const wallet = await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  assert(wallet.status === 201, `Wallet creation returned HTTP ${wallet.status}.`);
  const walletId = wallet.body.id;
  assert(typeof walletId === 'string', 'Wallet response is missing its identifier.');
  const common = { providerId: `smoke-${fixtureId}`, playerId, walletId, roundId: `round-${fixtureId}`, gameId: 'smoke', kind: 'BET', money: { amount: '80.00', currency: 'BRL' } };
  const operations = [0, 1].map(index => ({ ...common, externalTransactionId: `bet-${index}-${fixtureId}` }));
  const results = await Promise.all(operations.map(operation => post('/wagering/transactions', operation, `${common.providerId}:${operation.externalTransactionId}`)));
  for (const result of results) assert([200, 201, 422].includes(result.status), `BET returned HTTP ${result.status}.`);
  const processedIndex = results.findIndex(result => result.body.status === 'PROCESSED');
  assert(processedIndex >= 0 && results.filter(result => result.body.status === 'PROCESSED').length === 1, 'Exactly one competing BET must be processed.');
  assert(results.filter(result => result.body.status === 'REJECTED').length === 1, 'Exactly one competing BET must be rejected.');
  const processed = results[processedIndex]!.body as Transaction;
  const operation = operations[processedIndex]!;
  const replay = await post('/wagering/transactions', operation, `${common.providerId}:${operation.externalTransactionId}`);
  assert(replay.body.idempotentReplay === true && replay.body.transactionId === processed.transactionId, 'Replay must retain the original transaction.');
  const current = await request(`/wallets/${walletId}`);
  assert((current.body.balance as { amount?: unknown } | undefined)?.amount === '20.00', 'Concurrent wagers did not leave the expected balance.');

  const sqs = new SQSClient({ endpoint: config.sqsEndpoint, region: config.awsRegion, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
  try {
    const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: config.queueName }));
    assert(queue.QueueUrl, 'Input queue is missing.');
    const externalTransactionId = `loss-${fixtureId}`;
    const messageId = `smoke-${crypto.randomUUID()}`;
    await sqs.send(new SendMessageCommand({
      QueueUrl: queue.QueueUrl, MessageGroupId: walletId, MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...common, externalTransactionId, idempotencyKey: `${common.providerId}:${externalTransactionId}`, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } } }),
    }));
    await eventually(async () => {
      const result = await request(`/providers/${common.providerId}/wagering/transactions/${externalTransactionId}`);
      return result.status === 200 && result.body.status === 'PROCESSED';
    }, 'the SQS LOSS to commit');
  } finally {
    sqs.destroy();
  }
  const reconciliation = await post(`/wallets/${walletId}/reconciliation`, {});
  assert(reconciliation.status === 200 || reconciliation.status === 201, 'Reconciliation failed.');
  assert(reconciliation.body.consistent === true, 'Ledger reconciliation diverged.');
  assert((reconciliation.body.calculatedBalance as { amount?: unknown } | undefined)?.amount === '20.00', 'Ledger did not reconstruct the expected balance.');
  const ledger = await request(`/wallets/${walletId}/ledger?limit=100`);
  assert(ledger.status === 200 && Array.isArray(ledger.body.items), 'Ledger query failed.');
  const entries = ledger.body.items as Array<{ direction?: string }>;
  assert(entries.length === 2 && entries.filter(entry => entry.direction === 'DEBIT').length === 1, 'Expected only the opening credit and one BET debit in the ledger.');
  console.log(JSON.stringify({ level: 'info', event: 'smoke_passed', checks: ['health', 'concurrent_bets', 'idempotent_replay', 'sqs_consumption', 'ledger_reconciliation', 'unique_debit'], fixtureId }));
}

smoke().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', event: 'smoke_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
