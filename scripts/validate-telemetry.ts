import { DASHBOARD_UID, DATASOURCE_UID, TELEMETRY_QUERIES } from '../telemetry/queries';
import { check, eventually, jsonRequest, localEndpoint, reportFailure, writeEvidence } from '../telemetry/lib';

interface PromSample { metric: Record<string, string>; value: [number, string] }
interface QueryCheck { name: string; series: number; finiteSamples: number }

export async function validate(): Promise<void> {
  const started = performance.now();
  const prometheus = localEndpoint(process.env.PROMETHEUS_URL ?? 'http://localhost:9091', 'prometheus');
  const grafana = localEndpoint(process.env.GRAFANA_URL ?? 'http://localhost:3101', 'grafana');
  const username = process.env.GRAFANA_ADMIN_USER;
  const password = process.env.GRAFANA_ADMIN_PASSWORD;
  check(username && /^[a-zA-Z0-9_-]{1,64}$/.test(username) && password && /^[a-f0-9]{64}$/i.test(password), 'GRAFANA_PRIVATE_CREDENTIALS_REQUIRED');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const admin = (path: string) => jsonRequest(grafana, path, { headers: { Authorization: authorization } });

  await eventually(async () => {
    try { return (await fetch(new URL('/-/ready', prometheus), { signal: AbortSignal.timeout(3000), redirect: 'error' })).ok; }
    catch { return false; }
  }, 30000, 'PROMETHEUS_NOT_READY');
  let healthyTargets = 0;
  await eventually(async () => {
    const response = await jsonRequest(prometheus, '/api/v1/targets');
    const data = response.body.data as { activeTargets?: Array<{ health?: string; labels?: { job?: string } }> } | undefined;
    healthyTargets = data?.activeTargets?.filter(target => target.labels?.job === 'wallet-ledger-lab' && target.health === 'up').length ?? 0;
    return response.status === 200 && healthyTargets === 1;
  }, 30000, 'PROMETHEUS_TARGET_UNHEALTHY');

  let queryChecks: QueryCheck[] = [];
  let successful = false;
  for (let attempt = 0; attempt < 15 && !successful; attempt++) {
    queryChecks = [];
    successful = true;
    for (const [name, expression] of Object.entries(TELEMETRY_QUERIES)) {
      const response = await jsonRequest(prometheus, `/api/v1/query?query=${encodeURIComponent(expression)}`);
      const data = response.body.data as { resultType?: string; result?: PromSample[] } | undefined;
      check(response.status === 200 && response.body.status === 'success' && data?.resultType === 'vector' && Array.isArray(data.result), 'PROMETHEUS_QUERY_FAILED');
      const samples = data.result;
      const finite = samples.filter(sample => Array.isArray(sample.value) && Number.isFinite(Number(sample.value[1])));
      let valid = samples.length > 0 && finite.length === samples.length;
      if (name === 'scrape_up') valid &&= samples.length === 1 && Number(samples[0]!.value[1]) === 1;
      if (name === 'dependencies') valid &&= samples.length === 2 && samples.every(sample => Number(sample.value[1]) === 1);
      if (name === 'transactions') valid &&= samples.length === 5;
      successful &&= valid;
      queryChecks.push({ name, series: samples.length, finiteSamples: finite.length });
    }
    if (!successful) await Bun.sleep(1000);
  }
  check(successful, 'PROMETHEUS_QUERY_DATA_NOT_READY');

  const health = await jsonRequest(grafana, '/api/health');
  check(health.status === 200 && health.body.database === 'ok', 'GRAFANA_NOT_READY');
  const source = await admin(`/api/datasources/uid/${DATASOURCE_UID}`);
  check(source.status === 200 && source.body.type === 'prometheus' && source.body.url === 'http://prometheus:9090'
    && source.body.access === 'proxy', 'GRAFANA_DATASOURCE_NOT_PROVISIONED');
  const sourceHealth = await admin(`/api/datasources/uid/${DATASOURCE_UID}/health`);
  check(sourceHealth.status === 200 && sourceHealth.body.status === 'OK', 'GRAFANA_DATASOURCE_UNHEALTHY');
  const dashboardResponse = await admin(`/api/dashboards/uid/${DASHBOARD_UID}`);
  const dashboard = dashboardResponse.body.dashboard as { uid?: string; panels?: Array<{ datasource?: { uid?: string }; targets?: Array<{ datasource?: { uid?: string } }> }> } | undefined;
  const meta = dashboardResponse.body.meta as { provisioned?: boolean } | undefined;
  check(dashboardResponse.status === 200 && dashboard?.uid === DASHBOARD_UID && meta?.provisioned === true
    && Array.isArray(dashboard.panels) && dashboard.panels.length === 10
    && dashboard.panels.every(panel => panel.datasource?.uid === DATASOURCE_UID
      && panel.targets?.every(target => target.datasource?.uid === DATASOURCE_UID)), 'GRAFANA_DASHBOARD_NOT_PROVISIONED');

  const settings = await admin('/api/admin/settings');
  check(settings.status === 200, 'GRAFANA_SETTINGS_UNAVAILABLE');
  const sections = settings.body as Record<string, Record<string, unknown>>;
  const expectedSettings = [
    ['analytics', 'enabled', 'false'], ['analytics', 'reporting_enabled', 'false'],
    ['analytics', 'check_for_updates', 'false'], ['analytics', 'check_for_plugin_updates', 'false'],
    ['users', 'allow_sign_up', 'false'], ['auth.anonymous', 'enabled', 'false'],
    ['plugins', 'preinstall_disabled', 'true'], ['plugins', 'public_key_retrieval_disabled', 'true'],
  ];
  check(expectedSettings.every(([section, key, expected]) => String(sections[section!]?.[key!]) === expected), 'GRAFANA_LOCAL_SETTINGS_NOT_APPLIED');

  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), purpose: 'local-telemetry-validation', benchmark: false,
    checks: { prometheusReady: true, healthyApplicationTargets: healthyTargets, successfulQueries: queryChecks.length,
      grafanaReady: true, datasourceProvisioned: true, datasourceQueryHealthy: true, dashboardProvisioned: true,
      provisionedPanels: dashboard.panels.length, disabledExternalAnalyticsAndUpdates: true, privateLoginRequired: true },
    queries: queryChecks, validationElapsedMs: Math.round(performance.now() - started) };
  await writeEvidence('telemetry-validation.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ level: 'info', event: 'telemetry_validation_passed', healthyApplicationTargets: healthyTargets,
    successfulQueries: queryChecks.length, provisionedPanels: dashboard.panels.length, benchmark: false }));
}

if (import.meta.main) validate().catch(error => reportFailure('telemetry_validation_failed', error));
