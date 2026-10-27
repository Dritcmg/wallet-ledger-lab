import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

test('build output is independent of NODE_ENV and does not embed environment secrets', async () => {
  const directory = join(root, 'artifacts', 'private', 'build-regression', randomUUID());
  await mkdir(directory, { recursive: true });
  const secret = randomUUID();
  const hashes: string[] = [];
  for (const mode of ['development', 'test', 'production']) {
    const output = join(directory, mode);
    const child = Bun.spawn([process.execPath, 'build', './src/main.ts', '--target=bun', '--packages=external', `--outdir=${output}`], {
      cwd: root, env: { ...process.env, NODE_ENV: mode, DATABASE_URL: secret, GRAFANA_ADMIN_PASSWORD: secret },
      stdout: 'ignore', stderr: 'pipe',
    });
    const [, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    const bytes = await Bun.file(join(output, 'main.js')).bytes();
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes)).not.toContain(secret);
    hashes.push(createHash('sha256').update(bytes).digest('hex'));
  }
  expect(new Set(hashes).size).toBe(1);
}, 30_000);

test('crash injection requires both test runtime and the explicit switch', async () => {
  for (const [mode, switchValue, enabled] of [
    ['production', '1', false], ['development', '1', false], ['test', '0', false], ['test', '1', true],
  ] as const) {
    const child = Bun.spawn([process.execPath, '-e', 'import {config} from "./src/config.ts";console.log(JSON.stringify(config.testCrashAfterCommit));'], {
      cwd: root, env: { ...process.env, NODE_ENV: mode, TEST_CRASH_AFTER_COMMIT: switchValue }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toBe(enabled);
  }
}, 15_000);
