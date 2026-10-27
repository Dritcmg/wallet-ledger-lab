import { expect, test } from 'bun:test';
import type { FinanceService } from '../../src/application/finance.service';
import type { Database } from '../../src/infra/database';
import type { SqsBroker } from '../../src/infra/sqs';
import { createApp } from '../../src/transport/app';

function gauge(text: string, name: string, labels = ''): number {
  const line = text.split('\n').find(value => value.startsWith(`${name}${labels} `));
  if (!line) throw new Error(`Missing ${name}${labels}`);
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

test('metrics keep their last successful gauges and mark failed dependencies without leaking details', async () => {
  let healthy = true;
  const db = { dataSource: { query: async (sql: string) => {
    if (!healthy) throw new Error('postgresql://synthetic-user:synthetic-password@database.invalid/wager');
    return sql.includes('GROUP BY status')
      ? [{ status: 'PROCESSED', total: '17' }, { status: 'FAILED', total: '3' }]
      : [{ pending: '5', oldest: 120 }];
  } } } as unknown as Database;
  const broker = { deadLetterDepth: async () => {
    if (!healthy) throw new Error('AWS_SECRET_ACCESS_KEY=private-aws-secret');
    return 2;
  } } as unknown as SqsBroker;
  const app = await createApp(db, {} as FinanceService, broker);
  try {
    await app.listen(0, '127.0.0.1');
    const endpoint = `${await app.getUrl()}/metrics`;
    const first = await fetch(endpoint);
    expect(first.status).toBe(200);
    const snapshot = await first.text();
    expect(gauge(snapshot, 'wager_metrics_dependency_up', '{dependency="postgresql"}')).toBe(1);
    expect(gauge(snapshot, 'wager_metrics_dependency_up', '{dependency="sqs"}')).toBe(1);
    expect(gauge(snapshot, 'wager_transactions', '{status="PROCESSED"}')).toBe(17);
    expect(gauge(snapshot, 'wager_transactions', '{status="FAILED"}')).toBe(3);
    expect(gauge(snapshot, 'wager_outbox_pending_messages')).toBe(5);
    expect(gauge(snapshot, 'wager_outbox_oldest_age_seconds')).toBe(120);
    expect(gauge(snapshot, 'wager_dlq_messages')).toBe(2);

    healthy = false;
    const failed = await fetch(endpoint);
    expect(failed.status).toBe(200);
    expect(failed.headers.get('content-type')).toContain('text/plain');
    const stale = await failed.text();
    expect(gauge(stale, 'wager_metrics_dependency_up', '{dependency="postgresql"}')).toBe(0);
    expect(gauge(stale, 'wager_metrics_dependency_up', '{dependency="sqs"}')).toBe(0);
    expect(gauge(stale, 'wager_transactions', '{status="PROCESSED"}')).toBe(17);
    expect(gauge(stale, 'wager_transactions', '{status="FAILED"}')).toBe(3);
    expect(gauge(stale, 'wager_outbox_pending_messages')).toBe(5);
    expect(gauge(stale, 'wager_outbox_oldest_age_seconds')).toBe(120);
    expect(gauge(stale, 'wager_dlq_messages')).toBe(2);
    expect(stale).toContain('wager_http_requests_total');
    expect(stale).not.toContain('private-');
    expect(stale).not.toContain('synthetic-password');
    expect(stale).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(stale).not.toContain('postgresql://');
  } finally { await app.close(); }
}, 10_000);
