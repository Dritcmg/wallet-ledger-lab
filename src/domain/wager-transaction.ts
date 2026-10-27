import { assertNonEmpty, copyDate, CurrencyMismatchError, DomainError, FailureCode, IdempotencyConflictError, InvalidTransactionStateError } from './errors';
import { LedgerDirection } from './ledger';
import { Money } from './money';

export enum WagerTransactionKind {
  OPENING = 'OPENING', BET = 'BET', WIN = 'WIN', LOSS = 'LOSS', REFUND = 'REFUND', ROLLBACK = 'ROLLBACK',
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  PENDING = 'PENDING', PENDING_REFERENCE = 'PENDING_REFERENCE', PROCESSED = 'PROCESSED', REJECTED = 'REJECTED', FAILED = 'FAILED',
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'createdAt'> {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  private readonly _createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this._createdAt = copyDate(state.createdAt);
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt === undefined ? undefined : copyDate(state.processedAt);
  }

  /** OPENING is for trusted application code; transport adapters must refuse it. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      assertNonEmpty(props[field], field);
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new DomainError('INVALID_TRANSACTION_KIND', 'Unsupported transaction kind.');
    }
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.LOSS && props.money.isZero())) {
      throw new DomainError('INVALID_AMOUNT', 'Financial transactions must have a positive amount; LOSS may be zero.');
    }
    const required = props.kind === WagerTransactionKind.REFUND || props.kind === WagerTransactionKind.ROLLBACK;
    if (required && !props.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', 'This transaction requires an external reference.');
    }
    if (props.referenceExternalTransactionId !== undefined) {
      assertNonEmpty(props.referenceExternalTransactionId, 'referenceExternalTransactionId');
      if (props.referenceExternalTransactionId === props.externalTransactionId) {
        throw new DomainError('REFERENCE_MISMATCH', 'A transaction cannot reference itself.');
      }
      if (props.kind === WagerTransactionKind.BET || props.kind === WagerTransactionKind.OPENING) {
        throw new DomainError('INVALID_REFERENCE_KIND', 'BET and OPENING cannot reference another transaction.');
      }
    }
    return new WagerTransaction({ ...props, createdAt: props.createdAt ?? new Date(), status: WagerTransactionStatus.PENDING });
  }

  /** No business transitions run when restoring an already persisted record. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get createdAt(): Date { return copyDate(this._createdAt); }
  get processedAt(): Date | undefined { return this._processedAt === undefined ? undefined : copyDate(this._processedAt); }

  // Both nonterminal states may process, reject or fail. Waiting may repeat on retry.
  // All terminal states reject every transition, including a second transition to itself.
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if (this.referenceExternalTransactionId !== undefined && !referenceTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', 'Resolve the external reference before processing.');
    }
    if (referenceTransactionId !== undefined) assertNonEmpty(referenceTransactionId, 'referenceTransactionId');
    const processedAt = copyDate(at);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = processedAt;
    this._status = WagerTransactionStatus.PROCESSED;
  }

  markPendingReference(): void {
    this.assertMutable();
    if (this.referenceExternalTransactionId === undefined) {
      throw new DomainError('REFERENCE_REQUIRED', 'Only a transaction with an external reference may wait for it.');
    }
    this._status = WagerTransactionStatus.PENDING_REFERENCE;
  }

  reject(code: FailureCode): void {
    this.assertMutable();
    assertNonEmpty(code, 'failureCode');
    this._failureCode = code;
    this._status = WagerTransactionStatus.REJECTED;
  }

  fail(code: FailureCode): void {
    this.assertMutable();
    assertNonEmpty(code, 'failureCode');
    this._failureCode = code;
    this._status = WagerTransactionStatus.FAILED;
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.PROCESSED
      || this._status === WagerTransactionStatus.REJECTED
      || this._status === WagerTransactionStatus.FAILED;
  }

  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.LOSS; }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.REFUND || this.kind === WagerTransactionKind.ROLLBACK; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  assertMatchesPayload(payloadHash: string): void {
    if (!this.matchesPayload(payloadHash)) throw new IdempotencyConflictError();
  }

  /** Uniqueness of reversals belongs to the SQL transaction/unique constraint. */
  validateReference(reference: WagerTransaction): void {
    if (this.referenceExternalTransactionId !== reference.externalTransactionId
      || this.providerId !== reference.providerId
      || this.playerId !== reference.playerId
      || this.walletId !== reference.walletId
      || this.roundId !== reference.roundId
      || this.id === reference.id) {
      throw new DomainError('REFERENCE_MISMATCH', 'Reference must identify the same provider, player, wallet and round.');
    }
    if (this.money.currency !== reference.money.currency) throw new CurrencyMismatchError();
    if (reference.status !== WagerTransactionStatus.PROCESSED) {
      throw new DomainError('REFERENCE_NOT_PROCESSED', 'Only a processed transaction can be referenced.');
    }
    const allowed = this.kind === WagerTransactionKind.ROLLBACK
      ? [WagerTransactionKind.BET, WagerTransactionKind.WIN, WagerTransactionKind.REFUND]
      : [WagerTransactionKind.BET];
    if (!allowed.includes(reference.kind)) {
      throw new DomainError('INVALID_REFERENCE_KIND', 'The referenced transaction kind cannot be used by this operation.');
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new DomainError('REFERENCE_AMOUNT_MISMATCH', 'A reversal must match the full referenced amount.');
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.LOSS) {
      throw new DomainError('NO_LEDGER_ENTRY', 'LOSS does not produce a ledger entry.');
    }
    if (reference !== undefined) this.validateReference(reference);
    switch (this.kind) {
      case WagerTransactionKind.BET: return LedgerDirection.DEBIT;
      case WagerTransactionKind.OPENING:
      case WagerTransactionKind.WIN:
      case WagerTransactionKind.REFUND: return LedgerDirection.CREDIT;
      case WagerTransactionKind.ROLLBACK:
        if (reference === undefined) throw new DomainError('REFERENCE_REQUIRED', 'A rollback needs its resolved reference.');
        return reference.kind === WagerTransactionKind.BET ? LedgerDirection.CREDIT : LedgerDirection.DEBIT;
    }
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status);
  }
}
