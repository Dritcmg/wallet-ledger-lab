import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import {
  PROJECT_ROOT, REQUIRED_EVIDENCE, allowedPublicPath, collectPublicFiles, ensureWithin, junit,
  parseBunTests, privateDirectory, scanInventory, scanText, sha256, sourceManifest, trackedPathFindings,
} from '../../scripts/evidence-utils';
import { checkZip } from '../../scripts/publication-check';
import { deterministicArchive, evidenceGate } from '../../scripts/package-portfolio';
import { abortedSummary, parseAudit, validatedEntrypoint, type VerificationSummary } from '../../scripts/verify';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
function syntheticDirectory(): string {
  const parent = privateDirectory(join(PROJECT_ROOT, 'artifacts', 'private', 'tooling-fixtures'));
  return ensureWithin(parent, mkdtempSync(join(parent, 'case-')));
}

describe('public distribution allowlist', () => {
  test('allows source, attribution and only explicitly curated evidence', () => {
    for (const path of ['src/main.ts', 'tests/unit/example.test.ts', 'telemetry/grafana/dashboard.json', '.github/workflows/ci.yml', '.env.example', 'NOTICE.md', 'evidence/latest/summary.json']) expect(allowedPublicPath(path)).toBe(true);
    for (const path of ['../src/main.ts', '/src/main.ts', 'src/../main.ts', 'src\\main.ts', '.env', '.env.local', 'src/.env.example', '.git/config', 'artifacts/public/archive.zip', 'src/cache.dump', 'evidence/latest/raw.log', 'evidence/latest/unapproved.json']) expect(allowedPublicPath(path)).toBe(false);
    expect(trackedPathFindings(['src/main.ts', '.env', 'artifacts/private/output.log']).map(finding => finding.rule)).toEqual(['tracked_path_forbidden', 'tracked_path_forbidden']);
  });

  test('scans every source and test file while omitting private untracked artifacts', () => {
    const directory = syntheticDirectory(); mkdirSync(join(directory, 'src')); mkdirSync(join(directory, 'tests')); mkdirSync(join(directory, 'artifacts'));
    const token = ['gh', 'p_', 'Z'.repeat(36)].join('');
    writeFileSync(join(directory, 'src', 'fixture.ts'), `const value = '${token}';`);
    writeFileSync(join(directory, 'tests', 'fixture.ts'), `const value = '${token}';`);
    writeFileSync(join(directory, '.env'), token); writeFileSync(join(directory, 'artifacts', 'private.log'), token);
    const inventory = collectPublicFiles(directory);
    expect([...inventory.files.keys()].sort()).toEqual(['src/fixture.ts', 'tests/fixture.ts']);
    const result = scanInventory(inventory);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.every(finding => finding.rule === 'strong_token' && finding.line === 1)).toBe(true);
  });

  test('rejects symlinks and path escape before copying', () => {
    const directory = syntheticDirectory(); const target = syntheticDirectory(); mkdirSync(join(directory, 'src'));
    symlinkSync(target, join(directory, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(collectPublicFiles(directory).findings.some(finding => finding.rule === 'symlink_forbidden')).toBe(true);
    expect(() => ensureWithin(directory, join(directory, '..', 'outside'))).toThrow();
    expect(() => ensureWithin(directory, directory)).toThrow();
  });
});

describe('metadata-only privacy detector', () => {
  test('detects signed credential patterns, identifiers and private links without returning values', () => {
    const credential = ['postgresql', '://user:', 'real-secret-value', '@database.internal/test'].join('');
    const email = ['person', '@', 'private-domain.org'].join('');
    const phone = ['+55', '(11)', '98765-4321'].join(' ');
    const home = ['C:', 'Users', 'private-person', 'workspace'].join(String.fromCharCode(92));
    const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const link = ['https://', 'docs.google.com', '/document/d/private-id'].join('');
    const fixture = [credential, email, phone, home, key, link].join('\n');
    const findings = scanText('tests/fixture.ts', fixture);
    expect(new Set(findings.map(finding => finding.rule))).toEqual(new Set(['credential_uri', 'personal_email', 'personal_phone', 'private_home_path', 'private_key', 'private_link']));
    for (const finding of findings) expect(Object.keys(finding).sort()).toEqual(['line', 'path', 'rule']);
    expect(JSON.stringify(findings)).not.toContain('real-secret-value');
    expect(JSON.stringify(findings)).not.toContain(email);
  });

  test('retains exact placeholders and public attribution without exempting directories', () => {
    const input = ['postgresql://wager:GENERATED_BY_SETUP_LOCAL@localhost:55442/wager', 'postgresql://wager:development-placeholder@localhost:55442/wager', 'author@example.com', 'https://github.com/oven-sh/bun', 'https://opensource.org/license/mit'].join('\n');
    expect(scanText('NOTICE.md', input)).toEqual([]);
    expect(scanText('tests/fixture.ts', ['gh', 'p_', 'Z'.repeat(36)].join(''))).toHaveLength(1);
  });
});

const runnerLog = [
  'tests/unit/example.test.ts:', '(pass) accepts exact money [1.25ms]', '(pass) keeps wallet & ledger <balanced> [0.50ms]',
  'telemetry/lib.test.ts:', '(pass) validates local telemetry [2.00ms]', ' 3 pass', ' 0 fail', ' 9 expect() calls', 'Ran 3 tests across 2 files. [10.00ms]',
].join('\n');

describe('Bun log compatibility and public evidence', () => {
  test('matches the runner corpus and writes escaped JUnit without raw streams', () => {
    const result = parseBunTests('', runnerLog);
    expect(result).toMatchObject({ valid: true, total: 3, files: 2, passed: 3, failed: 0, assertions: 9 });
    expect(result.cases[0]!.durationSeconds).toBe(0.00125);
    const xml = junit(result, 'unit');
    expect(xml).toContain('&amp; ledger &lt;balanced&gt;');
    expect(xml).not.toContain('system-out'); expect(xml).not.toContain('system-err');
  });

  test('rejects mismatched summaries, missing markers and zero tests', () => {
    expect(parseBunTests('', runnerLog.replace(' 3 pass', ' 4 pass')).valid).toBe(false);
    expect(parseBunTests('', runnerLog.replace('(pass) accepts exact money [1.25ms]\n', '')).valid).toBe(false);
    expect(parseBunTests('', runnerLog.replace('tests/unit/example.test.ts:', 'artifacts/private/stage/tests/unit/example.test.ts:')).valid).toBe(false);
    expect(parseBunTests('', '0 pass\n0 fail\nRan 0 tests across 0 files.').valid).toBe(false);
    expect(parseBunTests('', runnerLog.replace(' 9 expect() calls\n', '')).assertions).toBeNull();
  });

  test('tracks failure and skip metadata instead of fabricating passing tests', () => {
    const result = parseBunTests('', 'tests/unit/failure.test.ts:\n(fail) rejects broken invariant [1ms]\n(skip) pending case\n0 pass\n1 fail\n1 skip\nRan 2 tests across 1 file.');
    expect(result).toMatchObject({ valid: true, passed: 0, failed: 1, skipped: 1, assertions: null });
    expect(junit(result, 'unit')).toContain('<failure'); expect(junit(result, 'unit')).toContain('<skipped/>');
  });

  test('auditing only certifies parsed empty audit JSON as clean', () => {
    expect(parseAudit('{}')).toEqual({ valid: true, affectedPackages: 0, advisoryEntries: 0 });
    expect(parseAudit('{"example":[{}]}')).toMatchObject({ valid: true, affectedPackages: 1, advisoryEntries: 1 });
    expect(parseAudit('network failed')).toMatchObject({ valid: false, affectedPackages: null });
  });

  test('rejects private entrypoints and records aborted verification as failed without fabricated cases', () => {
    expect(validatedEntrypoint('dist/main.js')).toBe('dist/main.js');
    expect(validatedEntrypoint('src/main.ts')).toBe('src/main.ts');
    expect(validatedEntrypoint('../private.ts')).toBeNull();
    expect(validatedEntrypoint(['/home', 'private-person', 'main.ts'].join('/'))).toBeNull();
    const summary = abortedSummary(sourceManifest(new Map([['src/main.ts', bytes('source')]])));
    expect(summary.status).toBe('FAILED'); expect(summary.tests.unit.valid).toBe(false);
    expect(summary.tests.unit.total).toBe(0); expect(summary.secretScan.findings).toBeNull();
  });
});

describe('archive and source integrity gates', () => {
  test('hashes executable inputs while excluding generated reports and documentation', () => {
    const files = new Map([['src/main.ts', bytes('source')], ['README.md', bytes('readme')], ['evidence/latest/summary.json', bytes('{}')]]);
    const first = sourceManifest(files).fingerprint;
    files.set('README.md', bytes('changed')); files.set('evidence/latest/summary.json', bytes('{"status":"FAILED"}'));
    expect(sourceManifest(files).fingerprint).toBe(first);
    files.set('src/main.ts', bytes('changed')); expect(sourceManifest(files).fingerprint).not.toBe(first);
  });

  test('creates deterministic safe ZIP bytes and rejects traversal and symlink entries', () => {
    const files = new Map([['src/main.ts', bytes('export {};')], ['NOTICE.md', bytes('Public attribution')]]);
    const archive = deterministicArchive(files);
    expect(sha256(archive)).toBe(sha256(deterministicArchive(new Map([...files].reverse()))));
    expect(checkZip(archive)).toMatchObject({ status: 'PASSED', scannedFiles: 2 });
    expect(checkZip(zipSync({ '../outside.ts': bytes('bad') })).status).toBe('FAILED');
    expect(checkZip(zipSync({ 'src/link.ts': [bytes('target'), { os: 3, attrs: 0o120777 << 16 }] })).findings.some(finding => finding.rule === 'zip_symlink_forbidden')).toBe(true);
  });

  test('blocks missing, stale, failed or tampered evidence', () => {
    const files = new Map<string, Uint8Array>();
    expect(evidenceGate(files, 'current').passed).toBe(false);
    for (const name of REQUIRED_EVIDENCE) files.set(`evidence/latest/${name}`, bytes('placeholder'));
    files.set('src/main.ts', bytes('source'));
    const manifest = sourceManifest(files);
    const testResults = parseBunTests('', runnerLog);
    const summary = { status: 'PASSED', source: { fingerprint: manifest.fingerprint },
      steps: ['typecheck', 'build', 'unit', 'integration', 'audit', 'publication', 'gitleaks-version', 'gitleaks', 'application-entrypoint', 'source-integrity', 'curated-publication'].map(name => ({ name, status: 'PASSED', exitCode: 0 })),
      artifact: { path: 'dist/main.js', sha256: sha256('compiled'), bytes: 8 }, runtime: { applicationEntrypoint: 'dist/main.js' },
      audit: { valid: true, affectedPackages: 0 }, publication: { status: 'PASSED', findings: [] },
      secretScan: { status: 'PASSED', version: '8.30.1', findings: 0 }, tests: { unit: testResults, integration: testResults } } as unknown as VerificationSummary;
    files.set('evidence/latest/summary.json', bytes(JSON.stringify(summary)));
    files.set('evidence/latest/source-manifest.json', bytes(JSON.stringify(manifest)));
    const refresh = () => files.set('evidence/latest/SHA256.txt', bytes([...files].filter(([path]) => path.startsWith('evidence/latest/') && !path.endsWith('/SHA256.txt')).map(([path, content]) => `${sha256(content)}  ${path.split('/').at(-1)}`).join('\n') + '\n'));
    refresh(); expect(evidenceGate(files, manifest.fingerprint).passed).toBe(true);
    expect(evidenceGate(files, 'changed').passed).toBe(false);
    files.set('evidence/latest/REPORT.md', bytes('tampered')); expect(evidenceGate(files, manifest.fingerprint).passed).toBe(false);
    refresh(); summary.status = 'FAILED'; files.set('evidence/latest/summary.json', bytes(JSON.stringify(summary))); refresh();
    expect(evidenceGate(files, manifest.fingerprint).passed).toBe(false);
  });
});
