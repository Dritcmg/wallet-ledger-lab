import { describe, expect, test } from 'bun:test';
import { DomainError, Money } from '../../src/domain';

function money(amount: string, currency = 'BRL'): Money { return Money.from({ amount, currency }); }

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe('Money contract', () => {
  test('serializes fixed-scale decimal strings and remains immutable', () => {
    const original = money('0.10');
    const result = original.add(money('0.20'));
    expect(result.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(original.toString()).toBe('0.10');
    expect(result).not.toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
    expect(money('0001.20').toString()).toBe('1.20');
    expect(JSON.stringify(result)).toBe('{"amount":"0.30","currency":"BRL"}');
  });

  test.each(['', '1', '1.0', '1.000', '0.001', '-1.00', '-0.00', '+1.00', '1e2', '1E2', 'NaN', 'Infinity', ' 1.00', '1.00 ', '.25', '1,00', '1.00\n'])('rejects malformed amount %j without rounding', (amount) => {
    expectCode(() => money(amount), 'INVALID_MONEY');
  });

  test.each(['brl', 'BR', 'BRLL', 'B1L', ' BRL', ''])('rejects malformed currency %j', (currency) => {
    expectCode(() => money('1.00', currency), 'INVALID_MONEY');
  });

  test.each(['ZZZ', 'ABC', 'AAA'])('rejects unassigned currency code %s in every factory', (currency) => {
    expectCode(() => money('1.00', currency), 'INVALID_MONEY');
    expectCode(() => Money.zero(currency), 'INVALID_MONEY');
    expectCode(() => Money.rehydrate({ amount: '-1.00', currency }), 'INVALID_MONEY');
  });

  test.each(['BRL', 'USD'])('retains recognized ISO currency %s as a string', (currency) => {
    expect(money('1.00', currency).toJSON()).toEqual({ amount: '1.00', currency });
    expect(Money.zero(currency).currency).toBe(currency);
    expect(Money.rehydrate({ amount: '-1.00', currency }).currency).toBe(currency);
  });

  test('rejects a currency number instead of coercing it to text', () => {
    expectCode(() => money('1.00', 986 as unknown as string), 'INVALID_MONEY');
  });

  test('rejects non-string monetary inputs at the runtime boundary', () => {
    for (const amount of [null, undefined, 10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCode(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' }), 'INVALID_MONEY');
    }
  });

  test('retains exactness at numeric(38,2) limits and rejects overflow', () => {
    const maximum = money('999999999999999999999999999999999999.99');
    expect(maximum.subtract(money('0.01')).toString()).toBe('999999999999999999999999999999999999.98');
    expectCode(() => maximum.add(money('0.01')), 'MONEY_OVERFLOW');
    expectCode(() => maximum.negate().subtract(money('0.01')), 'MONEY_OVERFLOW');
    expectCode(() => money('1000000000000000000000000000000000000.00'), 'MONEY_OVERFLOW');
  });

  test('supports signed internal deltas and persistence without allowing negative input', () => {
    const negative = money('0.10').subtract(money('0.20'));
    expect(negative.toString()).toBe('-0.10');
    expect(negative.isNegative()).toBe(true);
    expect(negative.negate().isPositive()).toBe(true);
    expect(Money.rehydrate(negative.toJSON()).equals(negative)).toBe(true);
    expect(Money.rehydrate({ amount: '-0.00', currency: 'BRL' }).toString()).toBe('0.00');
    expect(Money.zero('BRL').negate().isNegative()).toBe(false);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  test('rejects every cross-currency operation, including comparisons', () => {
    const brl = money('1.00');
    const usd = money('1.00', 'USD');
    for (const operation of [() => brl.add(usd), () => brl.subtract(usd), () => brl.equals(usd), () => brl.isLessThan(usd)]) {
      expectCode(operation, 'CURRENCY_MISMATCH');
    }
  });
});
