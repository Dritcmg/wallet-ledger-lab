import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = await realpath(resolve(import.meta.dir, '..'));
const envPath = resolve(root, '.env');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--plan')) throw new Error('Usage: bun scripts/setup-local.ts [--plan]');
const folders = ['artifacts/private', 'artifacts/public', 'evidence/latest'];
const exists = await Bun.file(envPath).exists();
console.log(JSON.stringify({ mode: args.includes('--plan') ? 'preview' : 'setup', files: [exists ? '.env (preserve)' : '.env (create private)'], directories: folders, externalRequests: false }));
if (args.includes('--plan')) process.exit(0);

for (const folder of folders) await mkdir(resolve(root, folder), { recursive: true, mode: folder === 'artifacts/private' ? 0o700 : 0o755 });
if (exists) {
  const text = await readFile(envPath, 'utf8');
  const values = Object.fromEntries(text.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  for (const name of ['POSTGRES_PASSWORD', 'TEST_POSTGRES_PASSWORD', 'GRAFANA_ADMIN_PASSWORD']) {
    if (!/^[a-f0-9]{64}$/.test(values[name] ?? '')) throw new Error(`Existing .env preserved; ${name} is not a generated local secret. Review the private file.`);
  }
  console.log('Existing private configuration retained; no secrets displayed.');
} else {
  const database = randomBytes(32).toString('hex');
  const testDatabase = randomBytes(32).toString('hex');
  const grafana = randomBytes(32).toString('hex');
  const lines = [
    '# Generated local configuration. Private, ignored by Git and excluded from distribution.',
    `POSTGRES_PASSWORD=${database}`, `TEST_POSTGRES_PASSWORD=${testDatabase}`,
    'GRAFANA_ADMIN_USER=labadmin', `GRAFANA_ADMIN_PASSWORD=${grafana}`,
    `DATABASE_URL=postgresql://wager:${database}@localhost:55442/wager`,
    `TEST_DATABASE_URL=postgresql://wager_test:${testDatabase}@localhost:55443/wager_test`,
    'SQS_ENDPOINT=http://localhost:4576', 'TEST_SQS_ENDPOINT=http://localhost:4577',
    'APP_BASE_URL=http://localhost:3100', 'PROMETHEUS_URL=http://localhost:9091', 'GRAFANA_URL=http://localhost:3101',
    'AWS_REGION=us-east-1', 'AWS_ACCESS_KEY_ID=test', 'AWS_SECRET_ACCESS_KEY=test', '',
  ];
  await writeFile(envPath, lines.join('\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log('Private .env created with independent random local secrets. Values are never printed.');
}
