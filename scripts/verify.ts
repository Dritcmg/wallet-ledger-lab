import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_ROOT, CURATED_FILES, badge, collectPublicFiles, evidenceDirectory, junit, parseBunTests,
  addCuratedEvidence, privateDirectory, privateWrite, scanText, sha256, sourceManifest, stageInventory, stripAnsi, type SourceManifest, type TestResults,
} from './evidence-utils';
import { checkPublication, type PublicationResult } from './publication-check';

interface Step { name: string; command: string; status: 'PASSED' | 'FAILED'; exitCode: number; durationMs: number; reason?: string }
interface CommandResult { step: Step; stdout: string; stderr: string }
export interface VerificationSummary {
  schemaVersion: 1; status: 'PASSED' | 'FAILED'; generatedAt: string;
  runtime: { bun: string; platform: string; arch: string; applicationEntrypoint: 'dist/main.js' | 'src/main.ts' | null };
  artifact: { path: 'dist/main.js'; sha256: string; bytes: number } | null;
  source: { fingerprint: string; algorithm: 'sha256'; scope: string };
  steps: Step[]; tests: { unit: TestResults; integration: TestResults };
  audit: { valid: boolean; affectedPackages: number | null; advisoryEntries: number | null };
  secretScan: { tool: 'gitleaks'; version: string | null; findings: number | null; status: 'PASSED' | 'FAILED' };
  publication: PublicationResult;
}

export function parseAudit(stdout: string): VerificationSummary['audit'] {
  try {
    const parsed: unknown = JSON.parse(stripAnsi(stdout).trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Unexpected audit schema.');
    const values = Object.values(parsed);
    return { valid: true, affectedPackages: values.length, advisoryEntries: values.every(Array.isArray) ? values.reduce((sum, value) => sum + (value as unknown[]).length, 0) : null };
  } catch { return { valid: false, affectedPackages: null, advisoryEntries: null }; }
}

export function validatedEntrypoint(value: string): 'dist/main.js' | 'src/main.ts' | null {
  return value === 'dist/main.js' || value === 'src/main.ts' ? value : null;
}

async function execute(name: string, args: string[], logDirectory: string, timeoutMs: number, executable = process.execPath, renderedCommand = ['bun', ...args].join(' ')): Promise<CommandResult> {
  const started = performance.now(); let stdout = ''; let stderr = ''; let exitCode = 1; let timedOut = false;
  try {
    const child = Bun.spawn([executable, ...args], { cwd: PROJECT_ROOT, env: process.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    try { [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); }
    finally { clearTimeout(timer); }
  } catch { stderr = 'Verifier could not start or collect this command. See the local environment configuration.'; }
  privateWrite(join(logDirectory, `${name}.stdout.log`), stdout);
  privateWrite(join(logDirectory, `${name}.stderr.log`), stderr);
  const step: Step = { name, command: renderedCommand, status: exitCode === 0 && !timedOut ? 'PASSED' : 'FAILED', exitCode, durationMs: Math.round(performance.now() - started), ...(timedOut ? { reason: 'timeout' } : {}) };
  console.log(JSON.stringify({ step: step.name, status: step.status, durationMs: step.durationMs }));
  return { step, stdout, stderr };
}

export function writeEvidenceChecksums(directory: string): void {
  const lines = CURATED_FILES.filter(name => name !== 'SHA256.txt' && existsSync(join(directory, name))).sort()
    .map(name => `${sha256(readFileSync(join(directory, name)))}  ${name}`);
  privateWrite(join(directory, 'SHA256.txt'), lines.join('\n') + '\n');
}

function writeEvidence(summary: VerificationSummary, manifest: SourceManifest, directory: string): void {
  privateDirectory(directory);
  const report = [
    '# Reproducible verification', '',
    `Status: **${summary.status}**. Generated: ${summary.generatedAt}.`, '',
    `Runtime: Bun ${summary.runtime.bun}; ${summary.runtime.platform}/${summary.runtime.arch}.`, '',
    `Integration application entrypoint: ${summary.runtime.applicationEntrypoint ?? 'unverified'}.`, '',
    summary.artifact ? `Built artifact: \`${summary.artifact.path}\`; ${summary.artifact.bytes} bytes; SHA-256 \`${summary.artifact.sha256}\`.` : 'Built artifact: unverified.', '',
    `Source fingerprint (SHA-256): \`${summary.source.fingerprint}\`.`, '',
    'The fingerprint covers executable source, tests, scripts, dependency lock and public configuration. Documentation and generated evidence are excluded to prevent a self-referencing fingerprint. The complete scope and per-file hashes are in source-manifest.json.', '',
    '| Step | Command | Status | Exit | Duration ms |', '| --- | --- | --- | --- | --- |',
    ...summary.steps.map(step => `| ${step.name} | \`${step.command}\` | ${step.status} | ${step.exitCode} | ${step.durationMs} |`), '',
    '| Suite | Passed | Failed | Skipped | Todo | Assertions | Parsed runner totals |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...(['unit', 'integration'] as const).map(name => { const test = summary.tests[name]; return `| ${name} | ${test.passed} | ${test.failed} | ${test.skipped} | ${test.todo} | ${test.assertions ?? 'not emitted'} | ${test.valid ? 'matched' : 'unverified'} |`; }), '',
    `Dependency audit: ${summary.audit.valid ? `${summary.audit.affectedPackages} affected packages` : 'unverified output'}. Publication policy: ${summary.publication.status}.`, '',
    `Native secret scan: Gitleaks ${summary.secretScan.version ?? 'unavailable'}; ${summary.secretScan.status}; ${summary.secretScan.findings ?? 'unverified'} findings.`, '',
    'JUnit contains case metadata only. Raw standard output and error streams remain in the ignored private artifacts directory and are never copied into this report or the distribution.', '',
    'These results describe the local laboratory and the recorded source fingerprint. Synthetic telemetry is a demonstration, not a performance benchmark. Pattern-based privacy checks and dependency auditing complement review; neither is a universal security guarantee.', '',
  ].join('\n');
  const documents: Record<string, string> = {
    'summary.json': JSON.stringify(summary, null, 2) + '\n', 'source-manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'REPORT.md': report, 'junit.unit.xml': junit(summary.tests.unit, 'unit'), 'junit.integration.xml': junit(summary.tests.integration, 'integration'),
    'status.svg': badge('verification', summary.status.toLowerCase(), summary.status === 'PASSED'),
    'test-badge.svg': badge('tests', `${summary.tests.unit.passed + summary.tests.integration.passed} passed / ${summary.tests.unit.failed + summary.tests.integration.failed} failed`, summary.status === 'PASSED'),
  };
  for (const [name, content] of Object.entries(documents)) {
    if (scanText(`evidence/latest/${name}`, content).length) throw new Error('Curated evidence failed its privacy policy.');
    privateWrite(join(directory, name), content);
  }
  writeEvidenceChecksums(directory);
}

export async function verify(): Promise<VerificationSummary> {
  const applicationEntrypoint = validatedEntrypoint(process.env.TEST_APP_ENTRYPOINT ?? 'src/main.ts');
  if (!applicationEntrypoint) throw new Error('Integration entrypoint must be a documented project entrypoint.');
  const directory = evidenceDirectory();
  const logs = privateDirectory(join(process.env.PRIVATE_ARTIFACTS_DIR ?? join(PROJECT_ROOT, 'artifacts', 'private'), `verify-${randomUUID()}`));
  const initial = collectPublicFiles(PROJECT_ROOT, false); const manifest = sourceManifest(initial.files);
  const commands = [
    ['typecheck', ['run', 'typecheck'], 120_000], ['build', ['run', 'build'], 120_000],
    ['unit', ['test', './tests/unit'], 180_000],
    ['integration', ['test', '--timeout', '120000', '--max-concurrency', '1', './tests/integration'], 600_000],
    ['audit', ['audit', '--json'], 120_000], ['publication', ['scripts/publication-check.ts', '--json'], 120_000],
  ] as const;
  const outputs = new Map<string, CommandResult>();
  let artifact: VerificationSummary['artifact'] = null;
  for (const [name, args, timeout] of commands) {
    const output = await execute(name, [...args], logs, timeout); outputs.set(name, output);
    if (name === 'build') {
      try {
        const bundle = readFileSync(join(PROJECT_ROOT, 'dist', 'main.js'));
        if (output.step.exitCode !== 0 || bundle.byteLength === 0) throw new Error('Build artifact unavailable.');
        artifact = { path: 'dist/main.js', sha256: sha256(bundle), bytes: bundle.byteLength };
      } catch { output.step.status = 'FAILED'; output.step.reason = 'build_artifact_missing_or_unverified'; }
    }
  }
  const secretInventory = collectPublicFiles(PROJECT_ROOT); addCuratedEvidence(secretInventory, directory);
  const secretStage = join(PROJECT_ROOT, 'artifacts', 'private', 'verification-stage', randomUUID());
  stageInventory(secretInventory.files, secretStage);
  const secretReport = join(logs, 'gitleaks-report.json'); privateWrite(secretReport, '');
  const versionCommand = await execute('gitleaks-version', ['version'], logs, 30_000, 'gitleaks', 'gitleaks version');
  const version = stripAnsi(versionCommand.stdout).trim().match(/^v?(\d+\.\d+\.\d+)$/)?.[1] ?? null;
  if (version !== '8.30.1') { versionCommand.step.status = 'FAILED'; versionCommand.step.reason = 'required_scanner_version_unavailable'; }
  outputs.set('gitleaks-version', versionCommand);
  const nativeScan = await execute('gitleaks', ['dir', secretStage, '--config', join(PROJECT_ROOT, '.gitleaks.toml'), '--redact', '--report-format', 'json', '--report-path', secretReport], logs, 120_000,
    'gitleaks', 'gitleaks dir public-stage --config .gitleaks.toml --redact --report-format json --report-path private-report.json');
  let secretFindings: number | null = null;
  try { const report: unknown = JSON.parse(readFileSync(secretReport, 'utf8')); if (Array.isArray(report)) secretFindings = report.length; } catch { /* Missing or invalid reports cannot pass the gate. */ }
  if (secretFindings !== 0 || secretInventory.findings.length) { nativeScan.step.status = 'FAILED'; nativeScan.step.reason = 'secret_scan_findings_or_unverified_report'; }
  outputs.set('gitleaks', nativeScan);
  const tests = { unit: parseBunTests(outputs.get('unit')!.stdout, outputs.get('unit')!.stderr), integration: parseBunTests(outputs.get('integration')!.stdout, outputs.get('integration')!.stderr) };
  for (const name of ['unit', 'integration'] as const) {
    const result = tests[name]; const step = outputs.get(name)!.step;
    if (!result.valid || result.failed || result.skipped || result.todo) { step.status = 'FAILED'; step.reason = 'runner_totals_or_cases_not_fully_passing'; }
  }
  const audit = parseAudit(outputs.get('audit')!.stdout);
  if (!audit.valid || audit.affectedPackages !== 0) { outputs.get('audit')!.step.status = 'FAILED'; outputs.get('audit')!.step.reason = 'audit_not_clean_or_unverified'; }
  let publication: PublicationResult;
  try {
    publication = JSON.parse(outputs.get('publication')!.stdout) as PublicationResult;
    if (!Array.isArray(publication.findings) || !['PASSED', 'FAILED'].includes(publication.status)) throw new Error('Invalid publication output.');
  } catch { publication = { schemaVersion: 1, status: 'FAILED', scannedFiles: 0, findings: [{ rule: 'publication_output_unverified', path: 'project', line: 0 }] }; }
  if (publication.status !== 'PASSED' || publication.findings.length) outputs.get('publication')!.step.status = 'FAILED';
  const integrityStarted = performance.now();
  const finalManifest = sourceManifest(collectPublicFiles(PROJECT_ROOT, false).files);
  const steps = [...outputs.values()].map(output => output.step);
  steps.push({ name: 'application-entrypoint', command: 'validate integration application entrypoint', status: applicationEntrypoint ? 'PASSED' : 'FAILED', exitCode: applicationEntrypoint ? 0 : 1, durationMs: 0 });
  steps.push({ name: 'source-integrity', command: 'source fingerprint comparison', status: finalManifest.fingerprint === manifest.fingerprint && !initial.findings.length ? 'PASSED' : 'FAILED', exitCode: finalManifest.fingerprint === manifest.fingerprint && !initial.findings.length ? 0 : 1, durationMs: Math.round(performance.now() - integrityStarted) });
  const summary: VerificationSummary = {
    schemaVersion: 1, status: steps.every(step => step.status === 'PASSED') ? 'PASSED' : 'FAILED', generatedAt: new Date().toISOString(),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, applicationEntrypoint }, artifact,
    source: { fingerprint: manifest.fingerprint, algorithm: 'sha256', scope: manifest.scope }, steps, tests, audit, publication,
    secretScan: { tool: 'gitleaks', version, findings: secretFindings, status: versionCommand.step.status === 'PASSED' && nativeScan.step.status === 'PASSED' ? 'PASSED' : 'FAILED' },
  };
  writeEvidence(summary, manifest, directory);
  const publicationStarted = performance.now();
  const finalPublication = await checkPublication();
  summary.publication = finalPublication;
  summary.steps.push({ name: 'curated-publication', command: 'publication check of curated evidence', status: finalPublication.status, exitCode: finalPublication.status === 'PASSED' ? 0 : 1, durationMs: Math.round(performance.now() - publicationStarted) });
  if (finalPublication.status !== 'PASSED') {
    summary.status = 'FAILED';
  }
  writeEvidence(summary, manifest, directory);
  return summary;
}

export function abortedSummary(manifest: SourceManifest): VerificationSummary {
  return {
    schemaVersion: 1, status: 'FAILED', generatedAt: new Date().toISOString(), runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, applicationEntrypoint: null }, artifact: null,
    source: { fingerprint: manifest.fingerprint, algorithm: 'sha256', scope: manifest.scope },
    steps: [{ name: 'verifier', command: 'bun scripts/verify.ts', status: 'FAILED', exitCode: 1, durationMs: 0, reason: 'pipeline_error_before_certification' }],
    tests: { unit: parseBunTests('', ''), integration: parseBunTests('', '') },
    audit: { valid: false, affectedPackages: null, advisoryEntries: null },
    secretScan: { tool: 'gitleaks', version: null, findings: null, status: 'FAILED' },
    publication: { schemaVersion: 1, status: 'FAILED', scannedFiles: 0, findings: [{ rule: 'verification_pipeline_error', path: 'project', line: 0 }] },
  };
}

if (import.meta.main) {
  try {
    if (process.argv.length > 2) throw new Error('verify does not accept arguments.');
    const summary = await verify();
    console.log(JSON.stringify({ status: summary.status, sourceFingerprint: summary.source.fingerprint, unit: summary.tests.unit.total, integration: summary.tests.integration.total }));
    process.exitCode = summary.status === 'PASSED' ? 0 : 1;
  } catch {
    try { const manifest = sourceManifest(collectPublicFiles(PROJECT_ROOT, false).files); writeEvidence(abortedSummary(manifest), manifest, evidenceDirectory()); } catch { /* An unwritable evidence destination cannot be certified. */ }
    console.error(JSON.stringify({ status: 'FAILED', rule: 'verification_pipeline_error', detail: 'No passing evidence was certified; inspect private local diagnostics.' }));
    process.exitCode = 1;
  }
}
