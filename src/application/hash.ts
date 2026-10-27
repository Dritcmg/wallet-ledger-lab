import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
