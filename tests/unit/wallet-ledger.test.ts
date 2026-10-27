import { describe, expect, test } from 'bun:test';
import { DomainError, LedgerDirection, Money, Wallet, WalletLedgerEntry } from '../../src/domain';

const at = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-01T00:01:00.000Z');
function money(amount: string, currency = 'BRL'): Money { return Money.from({ amount, currency }); }
function wallet(): Wallet { return Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: money('100.00'), at }); }

describe('Wallet invariant boundaries', () => {
  test('opens at version one, including a zero balance', () => {
    expect(wallet().version).toBe(1);
    const empty = Wallet.open({ id: 'empty', playerId: 'player', initialBalance: Money.zero('BRL'), at });
    expect(empty.balance.toString()).toBe('0.00');
    expect(empty.version).toBe(1);
    expect(() => Wallet.open({ id: 'negative', playerId: 'player', initialBalance: money('1.00').negate() })).toThrow(DomainError);
  });

  test('returns exact movement boundaries and increments version only after successful balance changes', () => {
    const aggregate = wallet();
    const debit = aggregate.debit(money('80.00'), later);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('20.00');
    expect(aggregate.balance).toBe(debit.balanceAfter);
    expect(aggregate.version).toBe(2);
    expect(aggregate.updatedAt).toEqual(later);
    expect(() => aggregate.debit(money('80.00'))).toThrow(DomainError);
    expect(aggregate.balance.toString()).toBe('20.00');
    expect(aggregate.version).toBe(2);
    const credit = aggregate.credit(money('0.01'), later);
    expect(credit.balanceAfter.toString()).toBe('20.01');
    expect(aggregate.version).toBe(3);
  });

  test('rejects zero/negative movements, currency mismatch and invalid timestamp without mutation', () => {
    const aggregate = wallet();
    for (const amount of [Money.zero('BRL'), money('1.00').negate(), money('1.00', 'USD')]) {
      expect(() => aggregate.debit(amount, later)).toThrow(DomainError);
      expect(() => aggregate.credit(amount, later)).toThrow(DomainError);
    }
    expect(() => aggregate.credit(money('1.00'), new Date('invalid'))).toThrow(DomainError);
    expect(aggregate.balance.toString()).toBe('100.00');
    expect(aggregate.version).toBe(1);
    expect(aggregate.updatedAt).toEqual(at);
  });

  test('rehydrates historical version and makes defensive date copies', () => {
    const inputAt = new Date(at);
    const aggregate = Wallet.rehydrate({ id: 'wallet', playerId: 'player', currency: 'BRL', balance: money('12.34'), version: 9, createdAt: inputAt, updatedAt: inputAt });
    inputAt.setUTCFullYear(1999);
    aggregate.createdAt.setUTCFullYear(1999);
    aggregate.updatedAt.setUTCFullYear(1999);
    expect(aggregate.createdAt).toEqual(at);
    expect(aggregate.updatedAt).toEqual(at);
    expect(aggregate.version).toBe(9);
  });
});

describe('Immutable wallet ledger', () => {
  test('reconciles a debit followed by credit with the materialized wallet', () => {
    const aggregate = wallet();
    const entries: WalletLedgerEntry[] = [];
    entries.push(WalletLedgerEntry.create({ id: 'opening', walletId: 'wallet', transactionId: 'opening-tx', direction: LedgerDirection.CREDIT, money: money('100.00'), balanceBefore: money('0.00'), balanceAfter: aggregate.balance, createdAt: at }));
    const debit = aggregate.debit(money('80.00'), later);
    entries.push(WalletLedgerEntry.create({ id: 'bet', walletId: 'wallet', transactionId: 'bet-tx', direction: LedgerDirection.DEBIT, money: money('80.00'), ...debit, createdAt: later }));
    const credit = aggregate.credit(money('15.10'), later);
    entries.push(WalletLedgerEntry.create({ id: 'win', walletId: 'wallet', transactionId: 'win-tx', direction: LedgerDirection.CREDIT, money: money('15.10'), ...credit, createdAt: later }));
    const reconstructed = entries.reduce((balance, entry) => entry.direction === LedgerDirection.CREDIT ? balance.add(entry.money) : balance.subtract(entry.money), Money.zero('BRL'));
    expect(reconstructed.equals(aggregate.balance)).toBe(true);
    expect(entries.every((entry) => entry.isBalanced() && Object.isFrozen(entry))).toBe(true);
    entries[0]!.createdAt.setUTCFullYear(1999);
    expect(entries[0]!.createdAt).toEqual(at);
  });

  test('rejects unreconciled, zero, negative-balance and cross-currency entries', () => {
    const base = { id: 'ledger', walletId: 'wallet', transactionId: 'tx', direction: LedgerDirection.DEBIT, money: money('10.00'), balanceBefore: money('100.00'), balanceAfter: money('90.00'), createdAt: at };
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: money('89.99') })).toThrow(DomainError);
    expect(() => WalletLedgerEntry.create({ ...base, money: Money.zero('BRL'), balanceAfter: base.balanceBefore })).toThrow(DomainError);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: money('1.00').negate() })).toThrow(DomainError);
    expect(() => WalletLedgerEntry.create({ ...base, money: money('10.00', 'USD') })).toThrow(DomainError);
  });
});
