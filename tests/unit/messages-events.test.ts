import { describe, expect, test } from 'bun:test';
import { DomainError, InboxMessage, LedgerDirection, Money, OutboxMessage, Wallet, WalletBalanceChanged, WalletLedgerEntry, WagerTransaction, WagerTransactionKind as Kind, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../../src/domain';

const at = new Date('2026-01-01T00:00:00.000Z');
const ctx = { eventId: 'event', correlationId: 'correlation', causationId: 'request', occurredAt: at };
const money = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
function transaction(kind = Kind.BET): WagerTransaction {
  return WagerTransaction.create({ id: 'transaction', providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', payloadHash: 'hash', walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game', kind, money: money('25.00'), ...(kind === Kind.REFUND ? { referenceExternalTransactionId: 'reference' } : {}), createdAt: at });
}
function processedEvent(): WagerTransactionProcessed {
  const tx = transaction();
  tx.markProcessed(undefined, at);
  return WagerTransactionProcessed.from(tx, ctx);
}

describe('Integration event envelopes', () => {
  test('processed events carry versioned decimal string data and copied dates', () => {
    const event = processedEvent();
    expect(event.toJSON()).toMatchObject({ eventId: 'event', eventType: 'WagerTransactionProcessed', aggregateId: 'transaction', correlationId: 'correlation', causationId: 'request', occurredAt: at.toISOString(), version: 1, data: { transactionId: 'transaction', money: { amount: '25.00', currency: 'BRL' }, processedAt: at.toISOString() } });
    event.occurredAt.setUTCFullYear(1999);
    expect(event.occurredAt).toEqual(at);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(() => WagerTransactionProcessed.from(transaction(), ctx)).toThrow(DomainError);
  });

  test('LOSS publishes a processed event without any wallet movement', () => {
    const tx = transaction(Kind.LOSS);
    tx.markProcessed(undefined, at);
    expect(WagerTransactionProcessed.from(tx, ctx).data.kind).toBe(Kind.LOSS);
    expect(tx.affectsBalance()).toBe(false);
  });

  test('rejection and reference waiting have distinct concrete types', () => {
    const rejected = transaction();
    rejected.reject('INSUFFICIENT_FUNDS');
    const rejection = WagerTransactionRejected.from(rejected, ctx);
    expect(rejection.eventType).toBe('WagerTransactionRejected');
    expect(rejection.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    const deferred = transaction(Kind.REFUND);
    deferred.markPendingReference();
    expect(WagerTransactionPendingReference.from(deferred, ctx).eventType).toBe('WagerTransactionPendingReference');
    expect(() => WagerTransactionRejected.from(deferred, ctx)).toThrow(DomainError);
  });

  test('wallet balance changes derive their monetary data from a reconciled ledger', () => {
    const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: money('100.00'), at });
    const movement = wallet.debit(money('25.00'), at);
    const entry = WalletLedgerEntry.create({ id: 'entry', walletId: 'wallet', transactionId: 'transaction', direction: LedgerDirection.DEBIT, money: money('25.00'), ...movement, createdAt: at });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.aggregateId).toBe(wallet.id);
    expect(event.data).toMatchObject({ balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' }, walletVersion: 2 });
    wallet.credit(money('1.00'), at);
    expect(() => WalletBalanceChanged.from(wallet, entry, ctx)).toThrow(DomainError);
  });
});

describe('Inbox and outbox state', () => {
  test('inbox completion is idempotent and preserves its first completion time', () => {
    const inbox = InboxMessage.receive({ messageId: 'message', consumerName: 'wagers', payloadHash: 'hash', receivedAt: at });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at);
    inbox.markProcessed(new Date('2026-01-02T00:00:00.000Z'));
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(at);
    inbox.processedAt!.setUTCFullYear(1999);
    expect(inbox.processedAt).toEqual(at);
    expect(InboxMessage.rehydrate({ messageId: 'message', consumerName: 'wagers', payloadHash: 'hash', receivedAt: at, processedAt: at }).isProcessed()).toBe(true);
  });

  test('outbox snapshots the envelope and schedules capped exponential backoff', () => {
    const outbox = OutboxMessage.enqueue(processedEvent());
    expect(outbox.id).toBe('event');
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(at)).toBe(true);
    expect(outbox.payload.eventType).toBe('WagerTransactionProcessed');
    expect(Object.isFrozen(outbox.payload)).toBe(true);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      outbox.scheduleRetry(at);
      const due = new Date(at.getTime() + delay);
      expect(outbox.nextAttemptAt).toEqual(due);
      expect(outbox.isDue(new Date(due.getTime() - 1))).toBe(false);
      expect(outbox.isDue(due)).toBe(true);
    }
    expect(outbox.attempts).toBe(8);
    outbox.markPublished(at);
    expect(outbox.publishedAt).toEqual(at);
    expect(outbox.nextAttemptAt).toBeUndefined();
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
    expect(() => outbox.scheduleRetry(at)).toThrow(DomainError);
    expect(() => outbox.markPublished(at)).toThrow(DomainError);
  });

  test('rehydrates delayed outbox delivery without resetting retry state', () => {
    const nextAttemptAt = new Date(at.getTime() + 60_000);
    const payload = { eventId: 'event', data: { amount: '1.00' } };
    const restored = OutboxMessage.rehydrate({ id: 'event', aggregateId: 'wallet', eventType: 'WalletBalanceChanged', payload, occurredAt: at, attempts: 12, nextAttemptAt });
    payload.data.amount = '999.00';
    nextAttemptAt.setUTCFullYear(1999);
    expect(restored.attempts).toBe(12);
    expect(restored.isDue(at)).toBe(false);
    expect(restored.payload.data).toEqual({ amount: '1.00' });
    expect(restored.nextAttemptAt).toEqual(new Date(at.getTime() + 60_000));
  });
});
