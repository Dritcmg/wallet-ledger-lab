import Decimal from 'decimal.js';
import { CurrencyMismatchError, DomainError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Each operand fits numeric(38, 2); 80 significant digits keep intermediate sums exact.
// This private constructor also isolates us from Decimal.set() in an adapter.
const ExactDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const MAX_AMOUNT = new ExactDecimal('999999999999999999999999999999999999.99');
// The pinned Bun runtime supplies ICU currency codes, including recognized historical codes.
const SUPPORTED_CURRENCIES = new Set<string>(Intl.supportedValuesOf('currency'));

export class Money {
  private constructor(private readonly value: Decimal, public readonly currency: string) {
    if (!value.isFinite() || value.abs().greaterThan(MAX_AMOUNT)) {
      throw new DomainError('MONEY_OVERFLOW', 'Amount exceeds the numeric(38, 2) range.');
    }
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  /** Persistence may contain signed deltas; public contracts must use from(). */
  static rehydrate(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  private static parse(props: MoneyProps, signed: boolean): Money {
    const pattern = signed ? /^-?[0-9]+\.[0-9]{2}$/ : /^[0-9]+\.[0-9]{2}$/;
    if (!props || typeof props.amount !== 'string' || pattern.exec(props.amount)?.[0] !== props.amount) {
      throw new DomainError('INVALID_MONEY', 'Amount must be a decimal string with exactly two decimal places.');
    }
    Money.assertCurrency(props.currency);
    const integer = props.amount.replace(/^-/, '').split('.')[0]!;
    if (integer.length > 36) {
      throw new DomainError('MONEY_OVERFLOW', 'Amount may contain at most 36 integer digits.');
    }
    return new Money(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new ExactDecimal('0.00'), currency);
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || currency.length !== 3 || !/^[A-Z]{3}$/.test(currency) || !SUPPORTED_CURRENCIES.has(currency)) {
      throw new DomainError('INVALID_MONEY', 'Currency must be a recognized three-letter uppercase ISO-4217 code.');
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return !this.value.isZero() && this.value.isPositive(); }
  isNegative(): boolean { return !this.value.isZero() && this.value.isNegative(); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
  toString(): string { return this.value.isZero() ? '0.00' : this.value.toFixed(2); }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError();
  }
}
