import { describe, expect, test } from 'bun:test';
import { canonicalJson, sha256 } from '../../src/application/hash';

describe('Canonical business payload hashing', () => {
  test('object order is normalized recursively while array order remains meaningful', () => {
    const first = { kind: 'BET', money: { currency: 'BRL', amount: '25.00' }, tags: ['a', 'b'] };
    const second = { tags: ['a', 'b'], money: { amount: '25.00', currency: 'BRL' }, kind: 'BET' };
    expect(sha256(first)).toBe(sha256(second));
    expect(sha256(first)).not.toBe(sha256({ ...first, tags: ['b', 'a'] }));
    expect(sha256(first)).toMatch(/^[a-f0-9]{64}$/);
  });
  test('a changed financial field conflicts and absent optional fields have a stable representation', () => {
    expect(sha256({ kind: 'BET', amount: '25.00' })).not.toBe(sha256({ kind: 'BET', amount: '25.01' }));
    expect(canonicalJson({ kind: 'BET', reference: undefined })).toBe(canonicalJson({ kind: 'BET' }));
  });
});
