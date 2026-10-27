import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import {
  PROJECT_ROOT, CURATED_FILES, REQUIRED_EVIDENCE, addCuratedEvidence, collectPublicFiles, ensureWithin,
  evidenceDirectory, inspectTrackedFiles, privateDirectory, privateWrite, scanInventory, sha256, sourceManifest, stageInventory,
  type Inventory, type ManifestEntry,
} from './evidence-utils';
import { checkZip, zipInventory } from './publication-check';
import type { VerificationSummary } from './verify';

export interface EvidenceGate { passed: boolean; reason: string }
export function evidenceGate(files: ReadonlyMap<string, Uint8Array>, fingerprint: string): EvidenceGate {
  try {
    for (const name of REQUIRED_EVIDENCE) if (!files.has(`evidence/latest/${name}`)) return { passed: false, reason: 'required_evidence_missing' };
    const summary = JSON.parse(new TextDecoder().decode(files.get('evidence/latest/summary.json')!)) as VerificationSummary;
    if (summary.status !== 'PASSED' || summary.source.fingerprint !== fingerprint) return { passed: false, reason: 'verification_failed_or_source_changed' };
    if (!summary.steps.length || summary.steps.some(step => step.status !== 'PASSED' || step.exitCode !== 0) || summary.secretScan.status !== 'PASSED' || summary.secretScan.version !== '8.30.1' || summary.secretScan.findings !== 0) return { passed: false, reason: 'verification_gates_not_passing' };
    const requiredSteps = ['typecheck', 'build', 'unit', 'integration', 'audit', 'publication', 'gitleaks-version', 'gitleaks', 'application-entrypoint', 'source-integrity', 'curated-publication'];
    if (requiredSteps.some(name => !summary.steps.some(step => step.name === name)) || !summary.audit.valid || summary.audit.affectedPackages !== 0 || summary.publication.status !== 'PASSED' || summary.publication.findings.length) return { passed: false, reason: 'verification_gates_missing_or_unverified' };
    if (!summary.artifact || summary.artifact.path !== 'dist/main.js' || !/^[a-f0-9]{64}$/.test(summary.artifact.sha256) || summary.artifact.bytes <= 0 || !['dist/main.js', 'src/main.ts'].includes(summary.runtime.applicationEntrypoint ?? '')) return { passed: false, reason: 'build_artifact_or_entrypoint_unverified' };
    for (const test of [summary.tests.unit, summary.tests.integration]) {
      if (!test.valid || test.total <= 0 || test.total !== test.cases.length || test.failed || test.skipped || test.todo || test.passed !== test.total || test.cases.some(item => item.status !== 'passed')) return { passed: false, reason: 'test_evidence_not_fully_passing' };
    }
    const manifest = JSON.parse(new TextDecoder().decode(files.get('evidence/latest/source-manifest.json')!)) as { fingerprint?: string; files?: ManifestEntry[] };
    if (manifest.fingerprint !== fingerprint || JSON.stringify(manifest.files) !== JSON.stringify(sourceManifest(files).files)) return { passed: false, reason: 'source_manifest_mismatch' };
    const lines = new TextDecoder().decode(files.get('evidence/latest/SHA256.txt')!).trim().split(/\r?\n/);
    const checked = new Set<string>();
    for (const line of lines) {
      const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/);
      if (!match || !CURATED_FILES.includes(match[2] as typeof CURATED_FILES[number]) || checked.has(match[2]!)) return { passed: false, reason: 'evidence_checksum_manifest_invalid' };
      const content = files.get(`evidence/latest/${match[2]}`);
      if (!content || sha256(content) !== match[1]) return { passed: false, reason: 'evidence_checksum_mismatch' };
      checked.add(match[2]!);
    }
    for (const name of CURATED_FILES) if (name !== 'SHA256.txt' && files.has(`evidence/latest/${name}`) && !checked.has(name)) return { passed: false, reason: 'evidence_checksum_missing' };
    return { passed: true, reason: 'verified_source_and_evidence' };
  } catch { return { passed: false, reason: 'evidence_unverified' }; }
}

export function deterministicArchive(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const source: Zippable = {};
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) source[path] = content;
  // ZIP stores local DOS fields; constructing local midnight fixes those fields in every timezone.
  return zipSync(source, { level: 9, mtime: new Date(2000, 0, 1, 0, 0, 0), os: 3, attrs: 0o100644 << 16 });
}

export async function packagePortfolio(apply = false): Promise<{ status: 'PASSED' | 'FAILED'; mode: 'plan' | 'apply'; [key: string]: unknown }> {
  const inventory = collectPublicFiles(PROJECT_ROOT); addCuratedEvidence(inventory, evidenceDirectory());
  inventory.findings.push(...await inspectTrackedFiles(PROJECT_ROOT));
  const findings = scanInventory(inventory); const manifest = sourceManifest(inventory.files);
  const gate = evidenceGate(inventory.files, manifest.fingerprint);
  const entries: ManifestEntry[] = [...inventory.files].map(([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: sha256(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
  const plan = {
    mode: apply ? 'apply' as const : 'plan' as const, sourceFingerprint: manifest.fingerprint, fileCount: entries.length,
    targets: ['artifacts/public/wallet-ledger-lab.zip', 'artifacts/public/wallet-ledger-lab.zip.sha256', 'artifacts/public/package-manifest.json'],
    evidence: gate.reason, findings, files: entries,
  };
  if (findings.length || !gate.passed) return { status: 'FAILED', ...plan };
  if (!apply) return { status: 'PASSED', ...plan };
  const stageRelativePath = `artifacts/private/distribution-stage/${randomUUID()}`;
  const stage = ensureWithin(PROJECT_ROOT, join(PROJECT_ROOT, ...stageRelativePath.split('/')));
  stageInventory(inventory.files, stage);
  const staged: Inventory = collectPublicFiles(stage); const stagedFindings = scanInventory(staged);
  if (stagedFindings.length || staged.files.size !== inventory.files.size) throw new Error('Staged publication policy failed.');
  for (const entry of entries) if (sha256(staged.files.get(entry.path) ?? new Uint8Array()) !== entry.sha256) throw new Error('Staged bytes changed.');
  const archive = deterministicArchive(staged.files); const archivedCheck = checkZip(archive); const unpacked = zipInventory(archive);
  if (archivedCheck.status !== 'PASSED' || unpacked.files.size !== entries.length) throw new Error('Archive publication policy failed.');
  for (const entry of entries) if (sha256(unpacked.files.get(entry.path) ?? new Uint8Array()) !== entry.sha256) throw new Error('Archive byte inventory mismatch.');
  if (sourceManifest(collectPublicFiles(PROJECT_ROOT, false).files).fingerprint !== manifest.fingerprint) throw new Error('Source changed during packaging.');
  const directory = ensureWithin(PROJECT_ROOT, join(PROJECT_ROOT, 'artifacts', 'public')); privateDirectory(directory);
  const digest = sha256(archive);
  privateWrite(join(directory, 'wallet-ledger-lab.zip'), archive);
  privateWrite(join(directory, 'wallet-ledger-lab.zip.sha256'), `${digest}  wallet-ledger-lab.zip\n`);
  privateWrite(join(directory, 'package-manifest.json'), JSON.stringify({ schemaVersion: 1, archive: 'wallet-ledger-lab.zip', sha256: digest, sourceFingerprint: manifest.fingerprint, stageRelativePath, fileCount: entries.length, files: entries }, null, 2) + '\n');
  return { status: 'PASSED', mode: 'apply', archive: 'artifacts/public/wallet-ledger-lab.zip', sha256: digest, sourceFingerprint: manifest.fingerprint, stageRelativePath, fileCount: entries.length };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && args[0] !== '--plan' && args[0] !== '--apply')) throw new Error('Unsupported package arguments.');
    const result = await packagePortfolio(args[0] === '--apply');
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'PASSED' ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ status: 'FAILED', rule: 'package_integrity_error', detail: 'No archive was certified; inspect the local verification and policy results.' })); process.exitCode = 1;
  }
}
