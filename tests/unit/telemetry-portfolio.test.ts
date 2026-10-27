import { expect, test } from 'bun:test';
import { jsonRequest, localEndpoint, sanitizeMetrics } from '../../telemetry/lib';

test('telemetry accepts only this labs loopback ports or explicit Compose hosts', () => {
  expect(localEndpoint('http://localhost:3100', 'api').port).toBe('3100');
  expect(localEndpoint('http://prometheus:9090', 'prometheus').hostname).toBe('prometheus');
  expect(localEndpoint('http://127.0.0.1:3101', 'grafana').hostname).toBe('127.0.0.1');
  const credentialed = new URL('http://localhost:3100');
  credentialed.username = 'synthetic';
  credentialed.password = 'REDACTED';
  expect(() => localEndpoint(credentialed.href, 'api')).toThrow();
  for (const endpoint of ['https://example.com:3100', 'http://localhost:3000', 'http://localhost:3100/?token=REDACTED']) {
    expect(() => localEndpoint(endpoint, 'api')).toThrow();
  }
});

test('public metrics snapshots retain only approved operational names and bounded labels', () => {
  const input = '# TYPE wager_transactions gauge\nwager_transactions{status="PROCESSED"} 3\n'
    + 'wager_http_requests_total{route="/wallets/:walletId",status="200",method="GET"} 2\n'
    + 'unapproved_financial_value 123.45\n';
  const result = sanitizeMetrics(input);
  expect(result.samples).toBe(2);
  expect(result.omitted).toBe(1);
  expect(result.text).not.toContain('123.45');
  expect(result.text).toContain('status="PROCESSED"');
});

test('public metrics snapshots refuse identifiers, arbitrary routes and credentials in labels', () => {
  for (const line of [
    'wager_transactions{walletId="0192f291-27dd-7d3f-8071-5f8685deef37"} 1',
    'wager_http_requests_total{route="/wallets/private-value"} 1',
    'wager_transactions{status="private-password"} 1',
    'wager_transactions NaN',
  ]) expect(() => sanitizeMetrics(line)).toThrow();
});

test('a non-JSON local response exposes only a stable failure code and HTTP status', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('REDACTED', { status: 503 }) });
  try {
    await expect(jsonRequest(new URL(`http://127.0.0.1:${server.port}`), '/')).rejects.toMatchObject({
      code: 'LOCAL_RESPONSE_NOT_JSON', httpStatus: 503,
    });
  } finally { await server.stop(true); }
});
