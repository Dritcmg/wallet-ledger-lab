import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export class TelemetryError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code); }
}
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new TelemetryError(code);
}

type LocalService = 'api' | 'prometheus' | 'grafana';
const ports = { api: ['3100', 'app', '3000'], prometheus: ['9091', 'prometheus', '9090'], grafana: ['3101', 'grafana', '3000'] } as const;
export function localEndpoint(value: string, service: LocalService): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new TelemetryError('INVALID_LOCAL_ENDPOINT'); }
  const [hostPort, composeHost, composePort] = ports[service];
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  check(endpoint.protocol === 'http:' && !endpoint.username && !endpoint.password
    && !endpoint.search && !endpoint.hash && endpoint.pathname === '/'
    && ((loopback && endpoint.port === hostPort) || (endpoint.hostname === composeHost && endpoint.port === composePort)),
  'LOCAL_ENDPOINT_REQUIRED');
  return endpoint;
}

export async function jsonRequest(endpoint: URL, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try { response = await fetch(new URL(path, endpoint), { ...init, signal: AbortSignal.timeout(8000), redirect: 'error' }); }
  catch { throw new TelemetryError('LOCAL_HTTP_REQUEST_FAILED'); }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new TelemetryError('LOCAL_RESPONSE_NOT_JSON', response.status); }
  check(body !== null && typeof body === 'object' && !Array.isArray(body), 'INVALID_LOCAL_RESPONSE');
  return { status: response.status, body: body as Record<string, unknown> };
}

export async function eventually(predicate: () => Promise<boolean>, timeoutMs: number, code: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  throw new TelemetryError(code);
}

const histogramNames = new Set(['wager_http_duration_seconds', 'wager_processing_duration_seconds', 'wager_sqs_processing_duration_seconds', 'wager_outbox_lag_seconds']);
const names = new Set([
  'wager_http_requests_total', 'wager_transactions', 'wager_transaction_responses_total', 'wager_duplicates_total',
  'wager_retries_total', 'wager_reference_retries_total', 'wager_dlq_messages_total', 'wager_dlq_messages',
  'wager_outbox_pending_messages', 'wager_outbox_oldest_age_seconds', 'wager_lock_conflicts_total',
  'wager_reconciliation_mismatches_total', 'wager_metrics_dependency_up', 'wager_outbox_published_total',
]);
const routes = new Set([
  '/wallets', '/wallets/:walletId', '/wallets/:walletId/ledger', '/wallets/:walletId/reconciliation',
  '/wagering/transactions', '/wagering/transactions/:transactionId',
  '/providers/:providerId/wagering/transactions/:externalTransactionId', '/health/live', '/health/ready', '/metrics', 'unmatched',
]);
const codes = new Set([
  '40001', '40P01', '23505', '55P03', 'INVALID_MESSAGE_CONTRACT', 'INFRASTRUCTURE_RETRY_EXHAUSTED',
  'INVALID_REQUEST', 'INVALID_PAYLOAD', 'INVALID_MONEY', 'INVALID_AMOUNT', 'MONEY_OVERFLOW', 'CURRENCY_MISMATCH',
  'INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS_FOR_REVERSAL', 'REFERENCE_REQUIRED', 'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_ALREADY_REVERSED', 'IDEMPOTENCY_CONFLICT', 'EXTERNAL_TRANSACTION_CONFLICT', 'MESSAGE_CONFLICT',
  'PLAYER_MISMATCH', 'WALLET_NOT_FOUND', 'INVALID_PROVIDER', 'INVALID_KIND', 'INVALID_TRANSACTION_STATE',
]);
function knownName(name: string): boolean {
  return names.has(name) || histogramNames.has(name)
    || [...histogramNames].some(base => ['_bucket', '_sum', '_count'].some(suffix => name === base + suffix));
}
function allowedLabel(key: string, value: string): boolean {
  switch (key) {
    case 'status': return ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'].includes(value) || /^[1-5][0-9]{2}$/.test(value);
    case 'source': return ['http', 'sqs'].includes(value);
    case 'worker': return ['sqs', 'outbox', 'pending-reference'].includes(value);
    case 'code': return codes.has(value);
    case 'method': return ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'].includes(value);
    case 'route': return routes.has(value);
    case 'dependency': return ['postgresql', 'sqs'].includes(value);
    case 'le': return ['0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '10', '30', '60', '+Inf'].includes(value);
    default: return false;
  }
}

/** Public snapshots contain approved operational series, never opaque labels. */
export function sanitizeMetrics(input: string): { text: string; samples: number; omitted: number } {
  const output: string[] = [];
  let samples = 0;
  let omitted = 0;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram)$/.exec(line);
      if (type && knownName(type[1]!)) output.push(line);
      continue;
    }
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? ([+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$/.exec(line);
    check(match, 'INVALID_METRICS_SNAPSHOT');
    const name = match[1]!;
    if (!knownName(name)) { omitted++; continue; }
    const labels: Record<string, string> = {};
    const rawLabels = match[2];
    if (rawLabels !== undefined) {
      const parsed = [...rawLabels.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g)];
      check(parsed.map(item => item[0]).join(',') === rawLabels, 'INVALID_METRIC_LABELS');
      for (const item of parsed) {
        const value = JSON.parse(`"${item[2]}"`) as string;
        check(allowedLabel(item[1]!, value) && labels[item[1]!] === undefined, 'UNSAFE_METRIC_LABEL');
        labels[item[1]!] = value;
      }
    }
    check(Number.isFinite(Number(match[3])), 'INVALID_METRIC_VALUE');
    const labelText = Object.keys(labels).sort().map(key => `${key}=${JSON.stringify(labels[key])}`).join(',');
    output.push(`${name}${labelText ? `{${labelText}}` : ''} ${match[3]}`);
    samples++;
  }
  check(samples > 0, 'EMPTY_METRICS_SNAPSHOT');
  return { text: output.join('\n') + '\n', samples, omitted };
}

export async function writeEvidence(filename: 'telemetry.json' | 'metrics.prom' | 'telemetry-validation.json', content: string): Promise<void> {
  const root = resolve(import.meta.dir, '..');
  const destination = resolve(process.env.EVIDENCE_DIR ?? resolve(root, 'evidence', 'latest'));
  const local = resolve(root, 'evidence', 'latest');
  check(destination === local || (process.platform !== 'win32' && destination === '/evidence/latest'), 'EVIDENCE_SCOPE_REQUIRED');
  const parent = resolve(destination, '..');
  for (const path of [parent, destination, resolve(destination, filename)]) {
    try { check(!(await lstat(path)).isSymbolicLink(), 'EVIDENCE_SYMLINK_REFUSED'); }
    catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  }
  await mkdir(destination, { recursive: true });
  const canonical = await realpath(destination);
  const expected = destination === local ? resolve(await realpath(root), 'evidence', 'latest') : '/evidence/latest';
  check(canonical === expected, 'EVIDENCE_SCOPE_REQUIRED');
  await writeFile(resolve(canonical, filename), content, { encoding: 'utf8', mode: 0o600 });
}

export function reportFailure(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event, code: error instanceof TelemetryError ? error.code : 'LOCAL_TELEMETRY_FAILED',
    ...(error instanceof TelemetryError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) }));
  process.exitCode = 1;
}
