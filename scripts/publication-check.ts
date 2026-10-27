import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import {
  PROJECT_ROOT, MAX_PUBLIC_FILE_BYTES, addCuratedEvidence, allowedPublicPath, collectPublicFiles,
  evidenceDirectory, inspectTrackedFiles, scanInventory, type Finding, type Inventory,
} from './evidence-utils';

export interface PublicationResult { schemaVersion: 1; status: 'PASSED' | 'FAILED'; scannedFiles: number; findings: Finding[] }
export async function checkPublication(root = PROJECT_ROOT, includeEvidence = true): Promise<PublicationResult> {
  const inventory = collectPublicFiles(root, includeEvidence);
  if (includeEvidence && root === PROJECT_ROOT) addCuratedEvidence(inventory, evidenceDirectory());
  inventory.findings.push(...await inspectTrackedFiles(root));
  const findings = scanInventory(inventory);
  return { schemaVersion: 1, status: findings.length ? 'FAILED' : 'PASSED', scannedFiles: inventory.files.size, findings };
}

export function zipInventory(bytes: Uint8Array): Inventory {
  const inventory: Inventory = { files: new Map(), findings: [] };
  const reject = (rule: string, path = 'archive'): void => { inventory.findings.push({ rule, path, line: 0 }); };
  if (bytes.byteLength > 32 * 1024 * 1024) { reject('archive_too_large'); return inventory; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) { reject('invalid_zip'); return inventory; }
  const count = view.getUint16(end + 10, true); let offset = view.getUint32(end + 16, true); let totalBytes = 0;
  const names = new Set<string>();
  if (count > 1000 || offset === 0xffffffff) { reject('unsupported_zip_limits'); return inventory; }
  try {
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid directory header.');
      const size = view.getUint32(offset + 24, true); const length = view.getUint16(offset + 28, true);
      const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + length));
      const mode = view.getUint32(offset + 38, true) >>> 16;
      if ((mode & 0o170000) === 0o120000) reject('zip_symlink_forbidden', name);
      if (!allowedPublicPath(name)) reject('public_path_forbidden', name);
      if (names.has(name)) reject('zip_duplicate_entry', name);
      if (size > MAX_PUBLIC_FILE_BYTES) reject('public_file_too_large', name);
      names.add(name); totalBytes += size;
      offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    if (totalBytes > 32 * 1024 * 1024) reject('archive_expansion_too_large');
    if (inventory.findings.length) return inventory;
    const content = unzipSync(bytes);
    for (const [path, data] of Object.entries(content)) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { reject('binary_content_forbidden', path); continue; }
      inventory.files.set(path, data);
    }
    if (inventory.files.size !== names.size) reject('zip_inventory_mismatch');
  } catch { reject('invalid_zip'); }
  return inventory;
}

export function checkZip(bytes: Uint8Array): PublicationResult {
  const inventory = zipInventory(bytes); const findings = scanInventory(inventory);
  return { schemaVersion: 1, status: findings.length ? 'FAILED' : 'PASSED', scannedFiles: inventory.files.size, findings };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2); let result: PublicationResult;
    if (args.length === 2 && args[0] === '--zip') result = checkZip(readFileSync(resolve(args[1]!)));
    else if (args.length === 0 || (args.length === 1 && args[0] === '--json')) result = await checkPublication();
    else throw new Error('Unsupported publication-check arguments.');
    result.status = result.findings.length ? 'FAILED' : 'PASSED';
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'PASSED' ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ schemaVersion: 1, status: 'FAILED', scannedFiles: 0, findings: [{ rule: 'publication_check_error', path: 'project', line: 0 }] }));
    process.exitCode = 1;
  }
}
