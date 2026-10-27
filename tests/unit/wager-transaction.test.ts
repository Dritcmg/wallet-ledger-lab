import { describe, expect, test } from 'bun:test';
import { CreateWagerTransactionProps, DomainError, LedgerDirection, Money, WagerTransaction, WagerTransactionKind as Kind, WagerTransactionState, WagerTransactionStatus as Status } from '../../src/domain';

const at = new Date('2026-01-01T00:00:00.000Z');
const money = (amount = '25.00', currency = 'BRL'): Money => Money.from({ amount, currency });
function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return { id: 'transaction', providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', payloadHash: 'hash', walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game', kind: Kind.BET, money: money(), createdAt: at, ...overrides };
}
function transaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction { return WagerTransaction.create(props(overrides)); }
function reference(kind = Kind.BET, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const tx = transaction({ id: 'reference', externalTransactionId: 'reference-external', kind, ...overrides });
  tx.markProcessed(undefined, at);
  return tx;
}
function reversal(kind: Kind = Kind.REFUND, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return transaction({ kind, referenceExternalTransactionId: 'reference-external', ...overrides });
}
function expectCode(action: () => unknown, code: string): void {
  try { action(); throw new Error(`Expected ${code}.`); }
  catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe('Transaction lifecycle', () => {
  test('starts pending and supports deferred reference then processing', () => {
    const tx = reversal();
    expect(tx.status).toBe(Status.PENDING);
    expect(tx.requiresReference()).toBe(true);
    tx.markPendingReference();
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PENDING_REFERENCE);
    expectCode(() => tx.markProcessed(undefined, at), 'REFERENCE_REQUIRED');
    expect(tx.status).toBe(Status.PENDING_REFERENCE);
    tx.markProcessed('reference', at);
    expect(tx.status).toBe(Status.PROCESSED);
    expect(tx.referenceTransactionId).toBe('reference');
    expect(tx.processedAt).toEqual(at);
    expect(tx.isTerminal()).toBe(true);
  });

  test.each([Status.PROCESSED, Status.REJECTED, Status.FAILED])('terminal status %s forbids every transition', (terminalStatus) => {
    const tx = reversal();
    if (terminalStatus === Status.PROCESSED) tx.markProcessed('reference', at);
    else if (terminalStatus === Status.REJECTED) tx.reject('REFERENCE_NOT_FOUND');
    else tx.fail('INFRASTRUCTURE_FAILURE');
    for (const transition of [() => tx.markProcessed('reference', at), () => tx.markPendingReference(), () => tx.reject('OTHER'), () => tx.fail('OTHER')]) {
      expectCode(transition, 'INVALID_TRANSACTION_STATE');
      expect(tx.status).toBe(terminalStatus);
    }
  });

  test('waiting transactions may reject or fail with an auditable code', () => {
    const rejected = reversal();
    rejected.markPendingReference();
    rejected.reject('REFERENCE_NOT_FOUND');
    expect(rejected.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(rejected.processedAt).toBeUndefined();
    const failed = reversal();
    failed.markPendingReference();
    failed.fail('STORAGE_CORRUPTION');
    expect(failed.failureCode).toBe('STORAGE_CORRUPTION');
  });

  test('rehydration restores persisted state without replaying creation or transitions', () => {
    const state: WagerTransactionState = { ...props(), createdAt: new Date(at), kind: Kind.REFUND, status: Status.REJECTED, failureCode: 'REFERENCE_REQUIRED' };
    const restored = WagerTransaction.rehydrate(state);
    expect(restored.kind).toBe(Kind.REFUND);
    expect(restored.status).toBe(Status.REJECTED);
    expect(restored.failureCode).toBe('REFERENCE_REQUIRED');
    expect(restored.referenceExternalTransactionId).toBeUndefined();
    state.createdAt.setUTCFullYear(1999);
    restored.createdAt.setUTCFullYear(1999);
    expect(restored.createdAt).toEqual(at);
  });

  test('same payload is a replay candidate; a different hash conflicts', () => {
    const tx = transaction();
    expect(tx.matchesPayload('hash')).toBe(true);
    expect(tx.matchesPayload('different')).toBe(false);
    expect(() => tx.assertMatchesPayload('hash')).not.toThrow();
    expectCode(() => tx.assertMatchesPayload('different'), 'IDEMPOTENCY_CONFLICT');
  });
});

describe('Wager operation rules', () => {
  test('BET debits, WIN and OPENING credit, LOSS never produces a ledger entry', () => {
    expect(transaction().ledgerDirectionFor()).toBe(LedgerDirection.DEBIT);
    expect(transaction({ kind: Kind.WIN }).ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    expect(transaction({ kind: Kind.OPENING }).ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    const loss = transaction({ kind: Kind.LOSS, money: money('0.00') });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.requiresReference()).toBe(false);
    loss.markProcessed(undefined, at);
    expect(loss.status).toBe(Status.PROCESSED);
    expectCode(() => loss.ledgerDirectionFor(), 'NO_LEDGER_ENTRY');
  });

  test.each([Kind.BET, Kind.WIN, Kind.REFUND, Kind.ROLLBACK, Kind.OPENING])('%s rejects zero and negative amounts', (kind) => {
    const ref = kind === Kind.REFUND || kind === Kind.ROLLBACK ? 'reference-external' : undefined;
    expectCode(() => transaction({ kind, money: Money.zero('BRL'), referenceExternalTransactionId: ref }), 'INVALID_AMOUNT');
    expectCode(() => transaction({ kind, money: money().negate(), referenceExternalTransactionId: ref }), 'INVALID_AMOUNT');
  });

  test.each([Kind.REFUND, Kind.ROLLBACK])('%s requires an external reference', (kind) => {
    expectCode(() => transaction({ kind }), 'REFERENCE_REQUIRED');
  });

  test('REFUND fully reverses only a processed BET', () => {
    const refund = reversal();
    expect(refund.ledgerDirectionFor(reference())).toBe(LedgerDirection.CREDIT);
    expectCode(() => refund.validateReference(reference(Kind.WIN)), 'INVALID_REFERENCE_KIND');
    expectCode(() => refund.validateReference(reference(Kind.BET, { money: money('24.99') })), 'REFERENCE_AMOUNT_MISMATCH');
    expectCode(() => refund.validateReference(transaction({ id: 'reference', externalTransactionId: 'reference-external' })), 'REFERENCE_NOT_PROCESSED');
  });

  test('ROLLBACK inverses BET, WIN and REFUND and refuses all other kinds', () => {
    const rollback = reversal(Kind.ROLLBACK);
    expect(rollback.ledgerDirectionFor(reference())).toBe(LedgerDirection.CREDIT);
    expect(rollback.ledgerDirectionFor(reference(Kind.WIN))).toBe(LedgerDirection.DEBIT);
    // Restore a legitimately persisted REFUND, including its already resolved BET.
    const refund = WagerTransaction.rehydrate({ ...props({ id: 'reference', externalTransactionId: 'reference-external', kind: Kind.REFUND, referenceExternalTransactionId: 'original-bet' }), createdAt: at, status: Status.PROCESSED, referenceTransactionId: 'bet', processedAt: at });
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.DEBIT);
    expectCode(() => rollback.ledgerDirectionFor(reference(Kind.LOSS)), 'INVALID_REFERENCE_KIND');
    expectCode(() => rollback.ledgerDirectionFor(reference(Kind.OPENING)), 'INVALID_REFERENCE_KIND');
    expectCode(() => rollback.ledgerDirectionFor(), 'REFERENCE_REQUIRED');
  });

  test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)('reference cannot cross %s', (field) => {
    expectCode(() => reversal().validateReference(reference(Kind.BET, { [field]: 'different' })), 'REFERENCE_MISMATCH');
  });

  test('reference currency is validated independently of its value', () => {
    expectCode(() => reversal().validateReference(reference(Kind.BET, { money: money('25.00', 'USD') })), 'CURRENCY_MISMATCH');
  });

  test('WIN may reference a BET with a different payout amount', () => {
    const win = transaction({ kind: Kind.WIN, money: money('50.00'), referenceExternalTransactionId: 'reference-external' });
    expect(win.ledgerDirectionFor(reference())).toBe(LedgerDirection.CREDIT);
    win.markProcessed('reference', at);
    expect(win.referenceTransactionId).toBe('reference');
  });

  test('self reference, empty reference and a BET reference are invalid', () => {
    expectCode(() => reversal(Kind.REFUND, { referenceExternalTransactionId: 'external' }), 'REFERENCE_MISMATCH');
    expectCode(() => reversal(Kind.REFUND, { referenceExternalTransactionId: ' ' }), 'INVALID_ARGUMENT');
    expectCode(() => transaction({ referenceExternalTransactionId: 'reference-external' }), 'INVALID_REFERENCE_KIND');
    expectCode(() => transaction().markPendingReference(), 'REFERENCE_REQUIRED');
  });
});
