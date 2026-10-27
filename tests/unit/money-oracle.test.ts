import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain';

/**
 * Normative source: README 6.1, decimal strings, exact arithmetic, scale 2.
 * Independent local oracle: integer cents using native BigInt; no Decimal calls.
 * Versioned corpus v1: boundary seeds plus 256 pairs from LCG seed 0x5eed.
 * No clocks, identifiers, transport or external data enter the comparison.
 */
function format(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const magnitude = cents < 0n ? -cents : cents;
  return `${sign}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

function corpus(): Array<readonly [bigint, bigint]> {
  const cases: Array<readonly [bigint, bigint]> = [
    [0n, 0n], [1n, 2n], [10n, 20n], [99n, 1n], [100n, 1n],
    [9_007_199_254_740_993n, 17n],
    [(10n ** 38n) - 1n, 0n],
  ];
  let seed = 0x5eedn;
  const modulus = 10n ** 35n;
  const next = (): bigint => {
    seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % modulus;
    return seed;
  };
  for (let index = 0; index < 256; index += 1) cases.push([next(), next()]);
  return cases;
}

describe('Money compatibility with independent BigInt oracle v1', () => {
  test('matches every deterministic addition, subtraction, comparison and signed round trip', () => {
    for (const [left, right] of corpus()) {
      const a = Money.from({ amount: format(left), currency: 'BRL' });
      const b = Money.from({ amount: format(right), currency: 'BRL' });
      expect(a.add(b).toString()).toBe(format(left + right));
      expect(a.subtract(b).toString()).toBe(format(left - right));
      expect(a.isLessThan(b)).toBe(left < right);
      expect(a.equals(b)).toBe(left === right);
      expect(a.negate().toString()).toBe(format(-left));
      expect(Money.rehydrate(a.subtract(b).toJSON()).toString()).toBe(format(left - right));
      expect(a.toString()).toBe(format(left));
    }
  });
});
