import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dir, '..');
export const REQUIRED_EVIDENCE = ['REPORT.md', 'SHA256.txt', 'junit.integration.xml', 'junit.unit.xml', 'source-manifest.json', 'status.svg', 'summary.json', 'test-badge.svg'] as const;
export const CURATED_FILES = [...REQUIRED_EVIDENCE, 'telemetry.json', 'metrics.prom', 'telemetry-validation.json'] as const;
const ROOT_FILES = new Set(['package.json', 'bun.lock', 'tsconfig.json', 'Dockerfile', 'compose.yaml', '.gitignore', '.dockerignore', '.gitleaks.toml', '.env.example', 'README.md', 'ARCHITECTURE.md', 'LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md', 'SECURITY.md', 'CONTRIBUTING.md']);
const PUBLIC_DIRS = new Set(['src', 'tests', 'scripts', 'telemetry', '.github', 'docs']);
const TEXT_EXTENSIONS = new Set(['.ts', '.json', '.yml', '.yaml', '.md', '.toml', '.svg', '.xml', '.prom']);
const FORBIDDEN_COMPONENTS = new Set(['.git', 'node_modules', 'artifacts', 'coverage', '.cache', '.tools', 'logs', 'dumps', 'dist', 'build', 'tmp', 'temp']);
export const MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024;
export interface Finding { rule: string; path: string; line: number }
export interface Inventory { files: Map<string, Uint8Array>; findings: Finding[] }
export interface ManifestEntry { path: string; sha256: string; bytes: number }
export interface SourceManifest { schemaVersion: 1; algorithm: 'sha256'; scope: string; fingerprint: string; files: ManifestEntry[] }
export const SOURCE_SCOPE = 'src/, tests/, scripts/, telemetry/, .github/, package.json, bun.lock, tsconfig.json, Dockerfile, compose.yaml, .env.example, .gitignore, .dockerignore, .gitleaks.toml; excludes docs, README, architecture, notices, licenses and generated evidence';
export function sha256(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export function allowedPublicPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || !/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || FORBIDDEN_COMPONENTS.has(part))) return false;
  if (parts.some(part => part.startsWith('.env') && !(parts.length === 1 && part === '.env.example'))) return false;
  if (parts.length === 1) return ROOT_FILES.has(path);
  if (parts[0] === 'evidence') return parts.length === 3 && parts[1] === 'latest' && CURATED_FILES.includes(parts[2] as typeof CURATED_FILES[number]);
  return PUBLIC_DIRS.has(parts[0]!) && TEXT_EXTENSIONS.has(extname(path));
}

export function ensureWithin(root: string, target: string): string {
  const base = resolve(root); const absolute = resolve(target); const suffix = relative(base, absolute);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) throw new Error('Target must be strictly inside its authorized root.');
  return absolute;
}

export function ensureNoSymlinks(target: string): void {
  let current = resolve(target);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are forbidden for artifact paths.');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  if (dirname(absolute) === absolute) throw new Error('A filesystem root is not an artifact directory.');
  ensureNoSymlinks(absolute); mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}
export function privateWrite(path: string, content: string | Uint8Array): void {
  ensureNoSymlinks(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 }); chmodSync(path, 0o600);
}
export function evidenceDirectory(): string { return resolve(process.env.EVIDENCE_DIR ?? join(PROJECT_ROOT, 'evidence', 'latest')); }
export function stageInventory(files: ReadonlyMap<string, Uint8Array>, directory: string): void {
  ensureWithin(PROJECT_ROOT, directory); privateDirectory(directory);
  for (const [path, bytes] of files) {
    if (!allowedPublicPath(path)) throw new Error('Unapproved staging path.');
    privateWrite(ensureWithin(directory, join(directory, ...path.split('/'))), bytes);
  }
}

export function collectPublicFiles(root: string, includeEvidence = true): Inventory {
  const files = new Map<string, Uint8Array>(); const findings: Finding[] = [];
  const base = realpathSync(root);
  const visit = (path: string): void => {
    if (scanText('path', path).length) { findings.push({ rule: 'private_filename_forbidden', path: '[redacted-path]', line: 0 }); return; }
    const absolute = ensureWithin(base, join(base, ...path.split('/')));
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) { findings.push({ rule: 'symlink_forbidden', path, line: 0 }); return; }
    const resolved = realpathSync(absolute);
    if (relative(base, resolved).startsWith('..') || isAbsolute(relative(base, resolved))) { findings.push({ rule: 'path_escape', path, line: 0 }); return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${path}/${name}`);
      return;
    }
    if (!stat.isFile() || !allowedPublicPath(path)) { findings.push({ rule: 'public_path_forbidden', path, line: 0 }); return; }
    if (stat.size > MAX_PUBLIC_FILE_BYTES) { findings.push({ rule: 'public_file_too_large', path, line: 0 }); return; }
    const bytes = readFileSync(absolute);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { findings.push({ rule: 'binary_content_forbidden', path, line: 0 }); return; }
    files.set(path, bytes);
  };
  for (const name of readdirSync(base).sort()) {
    if (ROOT_FILES.has(name) || PUBLIC_DIRS.has(name)) visit(name);
    else if (includeEvidence && name === 'evidence') {
      const directory = join(base, 'evidence', 'latest');
      if (existsSync(directory)) {
        if (lstatSync(join(base, 'evidence')).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) findings.push({ rule: 'symlink_forbidden', path: 'evidence/latest', line: 0 });
        else visit('evidence/latest');
      }
    }
  }
  return { files, findings };
}

export function addCuratedEvidence(inventory: Inventory, directory: string): void {
  ensureNoSymlinks(directory);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).sort()) {
    const path = `evidence/latest/${name}`;
    if (!allowedPublicPath(path)) { inventory.findings.push({ rule: 'unapproved_evidence_file', path, line: 0 }); continue; }
    const absolute = join(directory, name); const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PUBLIC_FILE_BYTES) { inventory.findings.push({ rule: 'invalid_evidence_file', path, line: 0 }); continue; }
    inventory.files.set(path, readFileSync(absolute));
  }
}

export function sourceManifest(files: ReadonlyMap<string, Uint8Array>): SourceManifest {
  const entries = [...files].filter(([path]) => !path.startsWith('evidence/') && !path.startsWith('docs/') && !['README.md', 'ARCHITECTURE.md', 'LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md', 'SECURITY.md', 'CONTRIBUTING.md'].includes(path))
    .map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.byteLength })).sort((a, b) => a.path.localeCompare(b.path));
  return { schemaVersion: 1, algorithm: 'sha256', scope: SOURCE_SCOPE, fingerprint: sha256(JSON.stringify(entries)), files: entries };
}

function reservedEmail(value: string): boolean { return /@(?:[^@.]+\.)*(?:example\.(?:com|org|net)|invalid|test|example)$/i.test(value); }
function syntheticCredential(user: string, password: string, host: string): boolean {
  const placeholder = /^(?:<[^>]+>|\$\{[^}]+\}|REPLACE_[A-Z_]+|GENERATED_BY_[A-Z_]+|CHANGE_ME|YOUR_[A-Z_]+|USERNAME|PASSWORD|test|example|local|local_only|development-placeholder|wager(?:_test)?_local_only|synthetic(?:[-_].*)?)$/i;
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\]|postgres(?:-test)?|localstack(?:-test)?)(?::\d+)?$/i.test(host);
  const reserved = /(?:^|\.)(?:example\.(?:com|org|net)|invalid|test)(?::\d+)?$/i.test(host);
  return (local && placeholder.test(password)) || (reserved && placeholder.test(user) && placeholder.test(password));
}

/** Metadata-only detector. It intentionally never returns matched values or source excerpts. */
export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (rule: string, index: number): void => {
    const line = text.slice(0, index).split('\n').length;
    const key = `${rule}:${line}`; if (!seen.has(key)) { seen.add(key); findings.push({ rule, path, line }); }
  };
  const check = (rule: string, pattern: RegExp): void => { for (const match of text.matchAll(pattern)) add(rule, match.index!); };
  check('private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g);
  check('strong_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35})\b/g);
  check('signed_jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g);
  check('private_home_path', /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'`]+/g);
  check('private_home_path', /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g);
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) if (!reservedEmail(match[0])) add('personal_email', match.index!);
  for (const match of text.matchAll(/\+\d[\d ().-]{7,24}\d|\b\(?\d{2,3}\)?[ .-]\d{4,5}[ .-]\d{4}\b/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15 && !/^1?\d{3}55501\d{2}$/.test(digits)) add('personal_phone', match.index!);
  }
  for (const match of text.matchAll(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|https?):\/\/([^/\s:@"'`]+):([^/\s@"'`]+)@([^/\s"'`]+)/gi)) {
    if (!syntheticCredential(match[1]!, match[2]!, match[3]!)) add('credential_uri', match.index!);
  }
  for (const match of text.matchAll(/https?:\/\/([^/\s"'`]+)([^\s"'`<>]*)/gi)) {
    const host = match[1]!.toLowerCase().replace(/:\d+$/, ''); const rest = match[2]!;
    if (/(?:^|\.)(?:adminml\.com|melioffice\.com|melisystems\.com|notion\.so|docs\.google\.com|drive\.google\.com)$/.test(host)
      || (host.endsWith('linkedin.com') && rest.startsWith('/in/')) || /[?&](?:access_token|auth_token|private_token|signature|x-amz-signature)=/i.test(rest)) add('private_link', match.index!);
  }
  return findings;
}

export function scanInventory(inventory: Inventory): Finding[] {
  return [...inventory.findings, ...[...inventory.files].flatMap(([path, bytes]) => [...scanText(path, path), ...scanText(path, new TextDecoder().decode(bytes))])]
    .map(finding => ({ ...finding, path: scanText('path', finding.path).length ? '[redacted-path]' : finding.path }));
}

export function trackedPathFindings(paths: readonly string[]): Finding[] { return paths.filter(path => !allowedPublicPath(path)).map(path => ({ rule: 'tracked_path_forbidden', path, line: 0 })); }
export async function inspectTrackedFiles(root: string): Promise<Finding[]> {
  if (!existsSync(join(root, '.git'))) return [];
  try {
    const process = Bun.spawn(['git', '-C', root, 'ls-files', '-z', '--cached'], { stdout: 'pipe', stderr: 'pipe' });
    const [output, , code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) return [{ rule: 'tracked_inventory_unavailable', path: '.git', line: 0 }];
    return trackedPathFindings(output.split('\0').filter(Boolean));
  } catch { return [{ rule: 'tracked_inventory_unavailable', path: '.git', line: 0 }]; }
}

export function stripAnsi(text: string): string { return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); }
export function curatedText(text: string): string {
  const clean = stripAnsi(text).replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[synthetic-id]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[local-address]').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '[control]').slice(0, 400);
  return scanText('curated', clean).length ? 'Redacted test case (privacy policy)' : clean;
}

export interface TestCase { file: string; name: string; status: 'passed' | 'failed' | 'skipped' | 'todo'; durationSeconds: number | null }
export interface TestResults { valid: boolean; issues: string[]; cases: TestCase[]; passed: number; failed: number; skipped: number; todo: number; total: number; files: number; assertions: number | null }
export function parseBunTests(stdout: string, stderr: string): TestResults {
  const text = stripAnsi(`${stdout}\n${stderr}`); const lines = text.split(/\r?\n/);
  const cases: TestCase[] = []; const files = new Set<string>(); const declared = new Map<string, number>(); const issues: string[] = [];
  let current = ''; let declaredTotal: number | null = null; let declaredFiles: number | null = null; let assertions: number | null = null;
  for (const line of lines) {
    const header = line.match(/^((?:tests[\\/](?:unit|integration)|telemetry)[\\/][A-Za-z0-9._\\/-]+\.test\.ts):\s*$/);
    if (header) { current = header[1]!.replace(/\\/g, '/'); files.add(current); continue; }
    const caseLine = line.match(/^\((pass|fail|skip|todo)\)\s+(.+)$/);
    if (caseLine) {
      let name = caseLine[2]!; let durationSeconds: number | null = null;
      const duration = name.match(/\s+\[(\d+(?:\.\d+)?)\s*(ms|s)\]\s*$/);
      if (duration) { name = name.slice(0, duration.index); durationSeconds = Number(duration[1]) / (duration[2] === 'ms' ? 1000 : 1); }
      if (!current) issues.push('case_without_source_file');
      cases.push({ file: current || 'tests/unknown.test.ts', name: curatedText(name), status: ({ pass: 'passed', fail: 'failed', skip: 'skipped', todo: 'todo' } as const)[caseLine[1] as 'pass' | 'fail' | 'skip' | 'todo'], durationSeconds });
      continue;
    }
    const summary = line.match(/^\s*(\d+)\s+(pass|fail|skip|todo)\s*$/); if (summary) declared.set(summary[2]!, Number(summary[1]));
    const run = line.match(/^Ran (\d+) tests? across (\d+) files?\b/); if (run) { declaredTotal = Number(run[1]); declaredFiles = Number(run[2]); }
    const assertionLine = line.match(/^\s*(\d+) expect\(\) calls?\s*$/); if (assertionLine) assertions = Number(assertionLine[1]);
  }
  const passed = cases.filter(test => test.status === 'passed').length; const failed = cases.filter(test => test.status === 'failed').length;
  const skipped = cases.filter(test => test.status === 'skipped').length; const todo = cases.filter(test => test.status === 'todo').length;
  for (const [name, count] of [['pass', passed], ['fail', failed], ['skip', skipped], ['todo', todo]] as const) if ((declared.get(name) ?? 0) !== count) issues.push(`summary_${name}_mismatch`);
  if (!declared.has('pass') || !declared.has('fail') || declaredTotal !== cases.length || declaredFiles !== files.size || cases.length === 0) issues.push('runner_totals_missing_or_mismatched');
  return { valid: issues.length === 0, issues, cases, passed, failed, skipped, todo, total: cases.length, files: files.size, assertions };
}

export function xmlEscape(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
export function junit(results: TestResults, name: string): string {
  const suites = new Map<string, TestCase[]>();
  for (const test of results.cases) suites.set(test.file, [...(suites.get(test.file) ?? []), test]);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="${xmlEscape(name)}" tests="${results.total}" failures="${results.failed}" skipped="${results.skipped + results.todo}">`];
  for (const [file, cases] of suites) {
    lines.push(`  <testsuite name="${xmlEscape(file)}" tests="${cases.length}" failures="${cases.filter(test => test.status === 'failed').length}" skipped="${cases.filter(test => test.status === 'skipped' || test.status === 'todo').length}">`);
    for (const test of cases) {
      lines.push(`    <testcase classname="${xmlEscape(file)}" name="${xmlEscape(test.name)}"${test.durationSeconds === null ? '' : ` time="${test.durationSeconds.toFixed(6)}"`}>`);
      if (test.status === 'failed') lines.push('      <failure message="Test failed; private diagnostic output is retained locally."/>');
      if (test.status === 'skipped' || test.status === 'todo') lines.push('      <skipped/>');
      lines.push('    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>'); return lines.join('\n') + '\n';
}

export function badge(label: string, value: string, passed: boolean): string {
  const color = passed ? '#15803d' : '#b91c1c';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="28" role="img" aria-label="${xmlEscape(`${label}: ${value}`)}"><title>${xmlEscape(`${label}: ${value}`)}</title><rect width="340" height="28" rx="4" fill="#1f2937"/><rect x="110" width="230" height="28" fill="${color}"/><g fill="white" font-family="Verdana,sans-serif" font-size="12" text-anchor="middle"><text x="55" y="19">${xmlEscape(label)}</text><text x="225" y="19">${xmlEscape(value)}</text></g></svg>\n`;
}
