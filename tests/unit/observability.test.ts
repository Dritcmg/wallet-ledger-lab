import { describe, expect, spyOn, test } from 'bun:test';
import { logger, Metrics } from '../../src/infra/observability';

describe('Operational telemetry contracts', () => {
  test('gauges replace current values while counters retain observed occurrences', () => {
    const telemetry = new Metrics();
    telemetry.set('wager_transactions', 2, { status: 'PENDING_REFERENCE' });
    telemetry.set('wager_transactions', 0, { status: 'PENDING_REFERENCE' });
    telemetry.set('wager_transactions', 2, { status: 'PROCESSED' });
    telemetry.increment('responses_total', { status: 'PROCESSED' });
    telemetry.increment('responses_total', { status: 'PROCESSED' });
    const text = telemetry.render();
    expect(text).toContain('# TYPE wager_transactions gauge');
    expect(text).toContain('wager_transactions{status="PENDING_REFERENCE"} 0');
    expect(text).toContain('wager_transactions{status="PROCESSED"} 2');
    expect(text).toContain('responses_total{status="PROCESSED"} 2');
  });
  test('structured logs retain correlation IDs and discard payloads and credentials', () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.info('contract_probe', { correlationId: 'correlation', messageId: 'message', transactionId: 'transaction',
        walletId: 'wallet', providerId: 'provider', password: 'never-log-password', token: 'never-log-token',
        payload: { money: { amount: '987654.32', currency: 'BRL' } } });
      const line = String(output.mock.calls[0]![0]);
      expect(JSON.parse(line)).toMatchObject({ event: 'contract_probe', correlationId: 'correlation',
        messageId: 'message', transactionId: 'transaction', walletId: 'wallet', providerId: 'provider' });
      expect(line).not.toContain('never-log');
      expect(line).not.toContain('987654.32');
      expect(line).not.toContain('payload');
    } finally { output.mockRestore(); }
  });
  test('histograms emit cumulative buckets and escape labels without financial values', () => {
    const telemetry = new Metrics();
    telemetry.observe('duration_seconds', 0.1, { route: 'say"hello' });
    telemetry.observe('duration_seconds', 1, { route: 'say"hello' });
    telemetry.observe('duration_seconds', Number.NaN);
    const text = telemetry.render();
    expect(text).toContain('duration_seconds_bucket{route="say\\"hello",le="0.1"} 1');
    expect(text).toContain('duration_seconds_bucket{route="say\\"hello",le="+Inf"} 2');
    expect(text).toContain('duration_seconds_count{route="say\\"hello"} 2');
    expect(text).not.toContain('NaN');
  });
});
