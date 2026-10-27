/** Stable machine-readable failures shared by the domain and its adapters. */
export type FailureCode =
  | 'INVALID_MONEY'
  | 'MONEY_OVERFLOW'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_FUNDS'
  | 'INSUFFICIENT_FUNDS_FOR_REVERSAL'
  | 'INVALID_TRANSACTION_STATE'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_MISMATCH'
  | 'INVALID_REFERENCE_KIND'
  | 'REFERENCE_AMOUNT_MISMATCH'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_LEDGER_ENTRY'
  | (string & {});

export class DomainError extends Error {
  constructor(public readonly code: FailureCode, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor() {
    super('CURRENCY_MISMATCH', 'All monetary values must have the same currency.');
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(code: 'INSUFFICIENT_FUNDS' | 'INSUFFICIENT_FUNDS_FOR_REVERSAL' = 'INSUFFICIENT_FUNDS') {
    super(code, 'The debit would leave the wallet with a negative balance.');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(status: string) {
    super('INVALID_TRANSACTION_STATE', `A terminal transaction (${status}) cannot transition.`);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT', 'The idempotency key is already associated with a different payload.');
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a non-empty string.`);
  }
}

export function copyDate(value: Date, field = 'date'): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a valid Date.`);
  }
  return new Date(value.getTime());
}
