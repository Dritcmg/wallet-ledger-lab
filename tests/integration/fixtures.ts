import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Subprocess } from 'bun';
import type { Database } from '../../src/infra/database';
import type { SqsBroker } from '../../src/infra/sqs';
import type { FinanceService } from '../../src/application/finance.service';
import type { SubmitTransactionInput, TransactionResult, WalletView } from '../../src/application/contracts';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://wager_test:development-placeholder@localhost:55443/wager_test';
export const testSqsEndpoint = process.env.TEST_SQS_ENDPOINT
  ?? (process.env.SQS_ENDPOINT?.includes('localstack-test') ? process.env.SQS_ENDPOINT : 'http://localhost:4577');

function assertLocalTestInfrastructure(): void {
  const database = new URL(testDatabaseUrl);
  const broker = new URL(testSqsEndpoint);
  if (!/(?:^|_)test(?:_|$)/i.test(database.pathname.slice(1))
    || !['localhost', '127.0.0.1', 'postgres-test', '[::1]'].includes(database.hostname)) {
    throw new Error('Integration tests require a local dedicated *_test database in TEST_DATABASE_URL.');
  }
  if (!['localhost', '127.0.0.1', 'localstack-test', '[::1]'].includes(broker.hostname)
    || (['localhost', '127.0.0.1', '[::1]'].includes(broker.hostname) && broker.port !== '4577')) {
    throw new Error('Integration tests require the isolated local test broker on port 4577 or localstack-test.');
  }
}
assertLocalTestInfrastructure();

// Configure before dynamically importing source modules, whose config is immutable.
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl, SQS_ENDPOINT: testSqsEndpoint,
  AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1',
  SQS_VISIBILITY_SECONDS: '2', SQS_MAX_ATTEMPTS: '3',
  REFERENCE_MAX_ATTEMPTS: '3', REFERENCE_TTL_SECONDS: '60', REFERENCE_RETRY_BASE_MS: '50',
  OUTBOX_LEASE_SECONDS: '3', WORKER_INTERVAL_MS: '100', SHUTDOWN_TIMEOUT_MS: '2000',
});

export interface ManagedProcess {
  child: Subprocess<'ignore', 'pipe', 'pipe'>;
  url?: string;
  output: Promise<string>;
}

export class IntegrationFixture {
  readonly walletIds = new Set<string>();
  readonly processes = new Set<ManagedProcess>();
  readonly apis: ManagedProcess[] = [];
  private constructor(readonly db: Database, readonly broker: SqsBroker, readonly finance: FinanceService) {}

  static async initialize(): Promise<IntegrationFixture> {
    const [{ Database }, { SqsBroker }, { FinanceService }] = await Promise.all([
      import('../../src/infra/database'), import('../../src/infra/sqs'), import('../../src/application/finance.service'),
    ]);
    const db = new Database(testDatabaseUrl);
    const broker = new SqsBroker();
    try {
      await db.initialize();
      await db.dataSource.runMigrations({ transaction: 'all' });
      await broker.provision();
      return new IntegrationFixture(db, broker, new FinanceService(db));
    } catch (error) {
      broker.close();
      await db.close();
      throw new Error('Real PostgreSQL/SQS test infrastructure is required. Start docker compose --profile test up -d postgres-test localstack-test.', { cause: error });
    }
  }

  async open(amount = '100.00', currency = 'BRL'): Promise<WalletView> {
    const wallet = await this.finance.openWallet({ playerId: randomUUID(), initialBalance: { amount, currency } });
    this.walletIds.add(wallet.id);
    return wallet;
  }

  input(wallet: WalletView, overrides: Partial<SubmitTransactionInput> = {}): SubmitTransactionInput {
    const externalTransactionId = randomUUID();
    return {
      providerId: `provider-${randomUUID()}`, externalTransactionId, idempotencyKey: `key:${externalTransactionId}`,
      walletId: wallet.id, playerId: wallet.playerId, roundId: `round-${randomUUID()}`, gameId: 'integration-game',
      kind: 'BET', money: { amount: '25.00', currency: wallet.balance.currency }, ...overrides,
    };
  }

  async spawn(role: 'api' | 'worker', extra: Record<string, string> = {}): Promise<ManagedProcess> {
    const port = await freePort();
    const entrypoint = process.env.TEST_APP_ENTRYPOINT ?? 'src/main.ts';
    const child = Bun.spawn([process.execPath, entrypoint], {
      cwd: process.cwd(), env: { ...process.env, APP_ROLE: role, PORT: String(port), TEST_CRASH_AFTER_COMMIT: '0', ...extra },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const managed: ManagedProcess = {
      child, url: `http://127.0.0.1:${port}`,
      output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(parts => parts.join('\n')),
    };
    this.processes.add(managed);
    {
      try {
        await eventually(async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Application exited with ${child.signalCode ?? child.exitCode}: ${(await managed.output).slice(-4000)}`);
          }
          try { return (await fetch(`${managed.url}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; }
          catch { return false; }
        }, 30_000, 'API subprocess readiness');
      } catch (error) { await this.stop(managed); throw error; }
    }
    return managed;
  }

  async startApis(): Promise<void> {
    this.apis.push(...await Promise.all([this.spawn('api'), this.spawn('api'), this.spawn('api')]));
  }

  async stop(managed: ManagedProcess): Promise<void> {
    if (managed.child.exitCode === null && managed.child.signalCode === null) {
      managed.child.kill('SIGTERM');
      const drained = await Promise.race([managed.child.exited.then(() => true), Bun.sleep(8000).then(() => false)]);
      if (!drained) { managed.child.kill('SIGKILL'); await managed.child.exited; }
    }
    await managed.child.exited;
    this.processes.delete(managed);
  }

  async assertConsistent(): Promise<void> {
    if (this.walletIds.size === 0) return;
    const mismatches = await this.db.dataSource.query(`
      SELECT w.id, w.balance::text, COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(38,2)::text AS reconstructed
      FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id
      WHERE w.id=ANY($1::uuid[]) GROUP BY w.id
      HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
    `, [[...this.walletIds]]);
    if (mismatches.length) throw new Error(`Wallet/ledger inconsistency: ${JSON.stringify(mismatches)}`);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.processes].map(process => this.stop(process)));
    try { await this.assertConsistent(); }
    finally { this.broker.close(); await this.db.close(); }
  }
}

export async function eventually(predicate: () => Promise<boolean>, timeoutMs = 15_000, description = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`);
}

/** exitCode remains null after a Unix signal; exited resolves for every termination. */
export async function waitForExit(process: ManagedProcess, timeoutMs: number, description: string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function sqlFailure(operation: () => Promise<unknown>, expectedCode: string): Promise<void> {
  let failure: unknown;
  try { await operation(); } catch (error) { failure = error; }
  const actual = (failure as { driverError?: { code?: string }; code?: string } | undefined)?.driverError?.code
    ?? (failure as { code?: string } | undefined)?.code;
  if (actual !== expectedCode) throw new Error(`Expected SQLSTATE ${expectedCode}; received ${actual ?? 'success'}.`, { cause: failure });
}

export async function postTransaction(api: ManagedProcess, input: SubmitTransactionInput): Promise<{ status: number; body: TransactionResult }> {
  const { idempotencyKey, ...body } = input;
  const response = await fetch(`${api.url}/wagering/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as TransactionResult };
}

export function requested(input: SubmitTransactionInput, messageId = randomUUID()): { messageId: string; type: 'WagerTransactionRequested'; correlationId: string; occurredAt: string; data: SubmitTransactionInput } {
  return { messageId, type: 'WagerTransactionRequested', correlationId: randomUUID(), occurredAt: new Date().toISOString(), data: input };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate an integration port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
