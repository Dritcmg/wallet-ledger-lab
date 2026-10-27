import { dirname, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';

const project = 'wallet-ledger-lab';
const allowedServices = new Set(['postgres', 'postgres-test', 'localstack', 'localstack-test', 'queues', 'migrate', 'app', 'tester', 'prometheus', 'grafana']);
const allowedVolumes = new Set([`${project}_postgres-data`, `${project}_postgres-test-data`, `${project}_prometheus-data`, `${project}_grafana-data`]);
const root = await realpath(resolve(import.meta.dir, '..'));
const composeFile = await realpath(resolve(root, 'compose.yaml'));
if (dirname(composeFile) !== root) throw new Error('Compose configuration must resolve inside this checkout.');
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.has('--apply') && args.has('--dry-run'))) {
  throw new Error('Usage: bun scripts/local-reset.ts [--dry-run | --apply]');
}
const apply = args.has('--apply');
const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'postgres-test', 'localstack', 'localstack-test']);
for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'SQS_ENDPOINT', 'APP_BASE_URL']) {
  const value = process.env[name];
  if (value && !localHosts.has(new URL(value).hostname)) throw new Error(`${name} points outside the dedicated local environment.`);
}
function docker(command: string[]): string {
  const result = Bun.spawnSync(['docker', ...command], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`docker ${command.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}
function ensureLocalDockerEndpoint(endpoint: string): void {
  if (endpoint.startsWith('npipe:////./pipe/') || endpoint.startsWith('unix:///')) return;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error('Cannot validate the Docker endpoint.'); }
  if (!['tcp:', 'http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Reset refuses a remote Docker daemon or context.');
  }
}
const context = docker(['context', 'show']);
const contexts = JSON.parse(docker(['context', 'inspect', context])) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
const endpoint = process.env.DOCKER_HOST ?? contexts[0]?.Endpoints?.docker?.Host;
if (!endpoint) throw new Error('Cannot identify the active Docker daemon.');
ensureLocalDockerEndpoint(endpoint);
// DOCKER_CONTEXT can take precedence over DOCKER_HOST, so validate both candidates.
if (contexts[0]?.Endpoints?.docker?.Host) ensureLocalDockerEndpoint(contexts[0].Endpoints.docker.Host);

type Labels = Record<string, string>;
type Container = { Id: string; Name: string; Config: { Labels?: Labels }; State: { Running: boolean } };
type Volume = { Name: string; Labels?: Labels };
type Network = { Id: string; Name: string; Labels?: Labels };
type Plan = { containers: Array<{ id: string; name: string; running: boolean }>; volumes: string[]; networks: Array<{ id: string; name: string }> };
const lines = (value: string): string[] => value ? value.split(/\r?\n/).filter(Boolean) : [];
const normalize = (path: string) => path.replaceAll('\\', '/').toLowerCase();
function ensureProject(labels: Labels | undefined): asserts labels is Labels {
  if (labels?.['com.docker.compose.project'] !== project) throw new Error('Resource ownership does not match the dedicated Compose project.');
}
function planReset(): Plan {
  const configuration = JSON.parse(docker(['compose', '-p', project, '-f', composeFile, '--profile', 'test', 'config', '--format', 'json'])) as { name?: string };
  if (configuration.name !== project) throw new Error('Unexpected Compose project.');
  const ids = lines(docker(['container', 'ls', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']));
  const containers = ids.length ? JSON.parse(docker(['container', 'inspect', ...ids])) as Container[] : [];
  for (const container of containers) {
    ensureProject(container.Config.Labels);
    const service = container.Config.Labels['com.docker.compose.service'];
    if (!service || !allowedServices.has(service)) throw new Error(`Unexpected service in reset scope: ${service ?? 'unknown'}.`);
    const files = container.Config.Labels['com.docker.compose.project.config_files'];
    if (!files || normalize(files) !== normalize(composeFile)) throw new Error(`Container ${container.Name} was created from another Compose configuration.`);
  }
  const names = lines(docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']));
  const volumes = names.length ? JSON.parse(docker(['volume', 'inspect', ...names])) as Volume[] : [];
  for (const volume of volumes) {
    ensureProject(volume.Labels);
    if (!allowedVolumes.has(volume.Name)) throw new Error(`Unexpected volume in reset scope: ${volume.Name}.`);
  }
  const networkIds = lines(docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']));
  const networks = networkIds.length ? JSON.parse(docker(['network', 'inspect', ...networkIds])) as Network[] : [];
  for (const network of networks) {
    ensureProject(network.Labels);
    if (![`${project}_default`, `${project}_lab`, `${project}_test`, `${project}_validation`].includes(network.Name)) throw new Error(`Unexpected network in reset scope: ${network.Name}.`);
  }
  return {
    containers: containers.map(container => ({ id: container.Id, name: container.Name.replace(/^\//, ''), running: container.State.Running })).sort((a, b) => a.id.localeCompare(b.id)),
    volumes: volumes.map(volume => volume.Name).sort(),
    networks: networks.map(network => ({ id: network.Id, name: network.Name })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
const plan = planReset();
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', project, root, composeFile, dockerContext: context, operations: {
  stopAndRemoveContainers: plan.containers,
  deleteDatabaseVolumes: plan.volumes,
  removeNetworks: plan.networks,
}, effects: 'Stops local demo and tests; destroys their databases and ephemeral SQS state. No host files are deleted.' }, null, 2));
if (!plan.containers.length && !plan.volumes.length && !plan.networks.length) {
  console.log('No dedicated local resources were found.');
} else if (!apply) {
  console.log('Preview only. Run again with --apply to execute this reset. Preserve a database dump first if the local data is needed.');
} else {
  const confirmed = planReset();
  if (JSON.stringify(confirmed) !== JSON.stringify(plan)) throw new Error('Resources changed during preview. Run the command again.');
  const running = plan.containers.filter(container => container.running).map(container => container.id);
  if (running.length) docker(['container', 'stop', '--time', '20', ...running]);
  if (plan.containers.length) docker(['container', 'rm', ...plan.containers.map(container => container.id)]);
  if (plan.volumes.length) docker(['volume', 'rm', ...plan.volumes]);
  if (plan.networks.length) docker(['network', 'rm', ...plan.networks.map(network => network.id)]);
  const remaining = planReset();
  if (remaining.containers.length || remaining.volumes.length || remaining.networks.length) throw new Error('Reset verification found resources remaining.');
  console.log('Dedicated local resources removed and absence verified.');
}
