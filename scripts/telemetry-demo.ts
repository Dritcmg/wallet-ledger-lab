import { check, eventually, jsonRequest, localEndpoint, reportFailure, sanitizeMetrics, writeEvidence } from '../telemetry/lib';

async function demo(): Promise<void> {
  const endpoint = localEndpoint(process.env.APP_BASE_URL ?? 'http://localhost:3100', 'api');
  const started = performance.now();
  let requests = 0;
  const request = async (path: string, init?: RequestInit) => {
    check(++requests <= 120, 'DEMO_REQUEST_LIMIT');
    return jsonRequest(endpoint, path, init);
  };
  const post = (path: string, body: unknown, key?: string) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  const metricsText = async (): Promise<string> => {
    check(++requests <= 120, 'DEMO_REQUEST_LIMIT');
    const response = await fetch(new URL('/metrics', endpoint), { signal: AbortSignal.timeout(8000), redirect: 'error' });
    check(response.ok, 'METRICS_UNAVAILABLE');
    return response.text();
  };
  const gauge = (text: string, name: string): number => {
    const line = text.split('\n').find(value => value.startsWith(`${name} `));
    return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
  };

  check((await request('/health/ready')).status === 200, 'API_NOT_READY');
  const retriesBefore = gauge(await metricsText(), 'wager_reference_retries_total');
  const token = crypto.randomUUID();
  const providerId = `lab-demo-${token}`;
  const playerA = crypto.randomUUID();
  const playerB = crypto.randomUUID();
  const create = async (playerId: string): Promise<string> => {
    const response = await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    check(response.status === 201 && typeof response.body.id === 'string', 'DEMO_WALLET_FAILED');
    return response.body.id;
  };
  const walletA = await create(playerA);
  const walletB = await create(playerB);
  const common = { providerId, playerId: playerA, walletId: walletA, roundId: `round-${token}`, gameId: 'local-demonstration' };
  const submit = (body: Record<string, unknown>) => post('/wagering/transactions', body, `${providerId}:${String(body.externalTransactionId)}`);
  const bets = [0, 1].map(index => ({ ...common, externalTransactionId: `bet-${index}-${token}`, kind: 'BET', money: { amount: '80.00', currency: 'BRL' } }));
  const race = await Promise.all(bets.map(submit));
  check(race.filter(result => result.status === 200 && result.body.status === 'PROCESSED').length === 1
    && race.filter(result => result.status === 422 && result.body.failureCode === 'INSUFFICIENT_FUNDS').length === 1,
  'DEMO_CONCURRENCY_FAILED');
  const winnerIndex = race.findIndex(result => result.body.status === 'PROCESSED');
  const winner = bets[winnerIndex]!;
  const originalBalance = race[winnerIndex]!.body.balance as { amount: string };
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => submit(winner)));
  check(duplicates.every(result => result.body.idempotentReplay === true), 'DEMO_REPLAY_FAILED');

  const loss = await submit({ ...common, externalTransactionId: `loss-${token}`, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } });
  check(loss.body.status === 'PROCESSED', 'DEMO_LOSS_FAILED');
  const winExternal = `win-${token}`;
  check((await submit({ ...common, externalTransactionId: winExternal, kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } })).body.status === 'PROCESSED', 'DEMO_WIN_FAILED');
  const historical = await submit(winner);
  check(historical.body.idempotentReplay === true
    && (historical.body.balance as { amount?: string }).amount === originalBalance.amount, 'DEMO_HISTORICAL_REPLAY_FAILED');
  check((await submit({ ...common, externalTransactionId: `rollback-${token}`, kind: 'ROLLBACK',
    referenceExternalTransactionId: winExternal, money: { amount: '5.00', currency: 'BRL' } })).body.status === 'PROCESSED', 'DEMO_ROLLBACK_FAILED');

  const delayed = { ...common, playerId: playerB, walletId: walletB, roundId: `delayed-${token}` };
  const betExternal = `delayed-bet-${token}`;
  const refundExternal = `refund-${token}`;
  const waiting = await submit({ ...delayed, externalTransactionId: refundExternal, kind: 'REFUND',
    referenceExternalTransactionId: betExternal, money: { amount: '25.00', currency: 'BRL' } });
  check(waiting.status === 202 && waiting.body.status === 'PENDING_REFERENCE', 'DEMO_PENDING_REFERENCE_FAILED');
  await eventually(async () => gauge(await metricsText(), 'wager_reference_retries_total') > retriesBefore,
    8000, 'DEMO_REFERENCE_RETRY_NOT_OBSERVED');
  check((await submit({ ...delayed, externalTransactionId: betExternal, kind: 'BET', money: { amount: '25.00', currency: 'BRL' } })).body.status === 'PROCESSED', 'DEMO_DELAYED_BET_FAILED');
  await eventually(async () => {
    const response = await request(`/providers/${providerId}/wagering/transactions/${refundExternal}`);
    return response.status === 200 && response.body.status === 'PROCESSED';
  }, 15000, 'DEMO_REFERENCE_NOT_RESOLVED');
  for (const wallet of [walletA, walletB]) {
    const response = await post(`/wallets/${wallet}/reconciliation`, {});
    check(response.status === 200 && response.body.consistent === true, 'DEMO_RECONCILIATION_FAILED');
  }
  let finalMetrics = '';
  await eventually(async () => {
    finalMetrics = await metricsText();
    return gauge(finalMetrics, 'wager_outbox_pending_messages') === 0;
  }, 10000, 'DEMO_OUTBOX_NOT_DRAINED');
  const snapshot = sanitizeMetrics(finalMetrics);
  const evidence = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), purpose: 'bounded-synthetic-local-demonstration', benchmark: false,
    limits: { maximumHttpRequests: 120, concurrentBetRequests: 2, initialReplayRequests: 4 },
    results: { walletsCreated: 2, httpRequests: requests, distinctPublicCommandsProcessed: 6, businessRejections: 1,
      duplicateReplaysVerified: 5, pendingReferencesAccepted: 1, referencesResolved: 1, consistentReconciliations: 2,
      referenceRetriesObserved: gauge(finalMetrics, 'wager_reference_retries_total') - retriesBefore,
      outboxDrained: true, historicalReplayVerified: true },
    metrics: { approvedSamples: snapshot.samples, omittedSamples: snapshot.omitted },
    demonstrationElapsedMs: Math.round(performance.now() - started),
  };
  await writeEvidence('metrics.prom', snapshot.text);
  await writeEvidence('telemetry.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ level: 'info', event: 'telemetry_demo_completed', httpRequests: requests,
    approvedMetricSamples: snapshot.samples, consistentReconciliations: 2, benchmark: false }));
}

if (import.meta.main) demo().catch(error => reportFailure('telemetry_demo_failed', error));
