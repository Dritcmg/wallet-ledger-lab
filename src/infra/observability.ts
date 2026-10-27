import type { Database } from './database';

type Labels = Readonly<Record<string, string | number>>;
type Fields = Readonly<Record<string, unknown>>;

// Logs deliberately accept identifiers and operational fields, never request bodies.
const allowedFields = new Set([
  'correlationId', 'messageId', 'transactionId', 'walletId', 'providerId', 'eventId',
  'status', 'code', 'attempt', 'delaySeconds', 'durationMs', 'method', 'path',
  'httpStatus', 'count', 'worker', 'signal', 'port', 'role', 'consistent',
]);
function write(level: string, event: string, fields: Fields = {}): void {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowedFields.has(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
      safe[key] = typeof value === 'string' ? value.slice(0, 256) : value as number | boolean | null;
    }
  }
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safe });
  if (level === 'error') console.error(line); else console.log(line);
}
export const logger = {
  info(event: string, fields?: Fields): void { write('info', event, fields); },
  error(event: string, fields?: Fields): void { write('error', event, fields); },
};

interface Counter { name: string; labels: Labels; value: number }
interface Histogram { name: string; labels: Labels; count: number; sum: number; buckets: number[] }
const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
function key(name: string, labels: Labels): string { return name + JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))); }
function nameOf(name: string): string { return name.replace(/[^a-zA-Z0-9_:]/g, '_'); }
function labelText(labels: Labels): string {
  const entries = Object.entries(labels);
  return entries.length ? '{' + entries.map(([k, v]) => `${nameOf(k)}="${String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`).join(',') + '}' : '';
}
export class Metrics {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, Counter>();

  set(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    this.gauges.set(key(name, labels), { name: nameOf(name), labels: { ...labels }, value });
  }

  increment(name: string, labels: Labels = {}): void {
    const id = key(name, labels);
    const counter = this.counters.get(id) ?? { name: nameOf(name), labels: { ...labels }, value: 0 };
    counter.value += 1;
    this.counters.set(id, counter);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const id = key(name, labels);
    const histogram = this.histograms.get(id) ?? { name: nameOf(name), labels: { ...labels }, count: 0, sum: 0, buckets: bounds.map(() => 0) };
    histogram.count += 1;
    histogram.sum += value;
    bounds.forEach((bound, i) => { if (value <= bound) histogram.buckets[i] = histogram.buckets[i]! + 1; });
    this.histograms.set(id, histogram);
  }

  render(): string {
    const lines: string[] = [];
    const types = new Set<string>();
    for (const counter of this.counters.values()) {
      if (!types.has(counter.name)) { lines.push(`# TYPE ${counter.name} counter`); types.add(counter.name); }
      lines.push(`${counter.name}${labelText(counter.labels)} ${counter.value}`);
    }
    for (const gauge of this.gauges.values()) {
      if (!types.has(gauge.name)) { lines.push(`# TYPE ${gauge.name} gauge`); types.add(gauge.name); }
      lines.push(`${gauge.name}${labelText(gauge.labels)} ${gauge.value}`);
    }
    for (const histogram of this.histograms.values()) {
      if (!types.has(histogram.name)) { lines.push(`# TYPE ${histogram.name} histogram`); types.add(histogram.name); }
      bounds.forEach((bound, i) => lines.push(`${histogram.name}_bucket${labelText({ ...histogram.labels, le: bound })} ${histogram.buckets[i]}`));
      lines.push(`${histogram.name}_bucket${labelText({ ...histogram.labels, le: '+Inf' })} ${histogram.count}`);
      lines.push(`${histogram.name}_sum${labelText(histogram.labels)} ${histogram.sum}`);
      lines.push(`${histogram.name}_count${labelText(histogram.labels)} ${histogram.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
export const metrics = new Metrics();

/** Database snapshots cover transitions performed by any process, including retries and FAILED. */
export async function refreshDatabaseMetrics(db: Database): Promise<void> {
  const [statuses, outbox] = await Promise.all([
    db.dataSource.query('SELECT status, count(*)::text AS total FROM wager_transactions GROUP BY status') as Promise<{ status: string; total: string }[]>,
    db.dataSource.query(`SELECT count(*)::text AS pending,
      COALESCE(EXTRACT(EPOCH FROM now() - MIN(occurred_at)), 0)::float8 AS oldest
      FROM outbox_messages WHERE published_at IS NULL`) as Promise<{ pending: string; oldest: number }[]>,
  ]);
  for (const status of ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']) {
    metrics.set('wager_transactions', Number(statuses.find(row => row.status === status)?.total ?? 0), { status });
  }
  metrics.set('wager_outbox_pending_messages', Number(outbox[0]!.pending));
  metrics.set('wager_outbox_oldest_age_seconds', Math.max(0, outbox[0]!.oldest));
}
