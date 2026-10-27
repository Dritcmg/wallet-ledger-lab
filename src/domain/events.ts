import { assertNonEmpty, copyDate, DomainError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger';
import { MoneyProps } from './money';
import { Wallet } from './wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot JSON values so callers cannot change an already queued event. */
export function immutableJsonSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  private readonly _occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    assertNonEmpty(props.eventId, 'eventId');
    assertNonEmpty(props.aggregateId, 'aggregateId');
    assertNonEmpty(props.correlationId, 'correlationId');
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = copyDate(props.occurredAt);
    this.data = immutableJsonSnapshot(props.data);
  }

  get occurredAt(): Date { return copyDate(this._occurredAt); }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: immutableJsonSnapshot(this.data) as T,
    };
  }
}

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  status: WagerTransactionStatus.PROCESSED;
  processedAt: string;
}
export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  status: WagerTransactionStatus.REJECTED;
  failureCode: string;
}
export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  status: WagerTransactionStatus.PENDING_REFERENCE;
}
export interface WagerTransactionFailedData extends WagerTransactionEventData {
  status: WagerTransactionStatus.FAILED;
  failureCode: string;
}
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

function transactionData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.referenceTransactionId === undefined ? {} : { referenceTransactionId: transaction.referenceTransactionId }),
  };
}

function envelope<T>(aggregateId: string, data: T, ctx: EventContext): IntegrationEventProps<T> {
  return { ...ctx, aggregateId, occurredAt: ctx.occurredAt ?? new Date(), data };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) { super(props); Object.freeze(this); }
  static create(props: IntegrationEventProps<WagerTransactionProcessedData>): WagerTransactionProcessed { return new WagerTransactionProcessed(props); }
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.PROCESSED || transaction.processedAt === undefined) {
      throw new DomainError('INVALID_TRANSACTION_STATE', 'Processed events require a processed transaction.');
    }
    return this.create(envelope(transaction.id, {
      ...transactionData(transaction), status: WagerTransactionStatus.PROCESSED, processedAt: transaction.processedAt.toISOString(),
    }, ctx));
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) { super(props); Object.freeze(this); }
  static create(props: IntegrationEventProps<WagerTransactionRejectedData>): WagerTransactionRejected { return new WagerTransactionRejected(props); }
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (transaction.status !== WagerTransactionStatus.REJECTED || transaction.failureCode === undefined) {
      throw new DomainError('INVALID_TRANSACTION_STATE', 'Rejected events require a rejected transaction.');
    }
    return this.create(envelope(transaction.id, {
      ...transactionData(transaction), status: WagerTransactionStatus.REJECTED, failureCode: transaction.failureCode,
    }, ctx));
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) { super(props); Object.freeze(this); }
  static create(props: IntegrationEventProps<WagerTransactionPendingReferenceData>): WagerTransactionPendingReference { return new WagerTransactionPendingReference(props); }
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) {
      throw new DomainError('INVALID_TRANSACTION_STATE', 'Pending reference events require a waiting transaction.');
    }
    return this.create(envelope(transaction.id, { ...transactionData(transaction), status: WagerTransactionStatus.PENDING_REFERENCE }, ctx));
  }
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerTransactionFailedData>) { super(props); Object.freeze(this); }
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    if (transaction.status !== WagerTransactionStatus.FAILED || !transaction.failureCode) {
      throw new DomainError('INVALID_TRANSACTION_STATE', 'Failed events require an auditably failed transaction.');
    }
    return new WagerTransactionFailed(envelope(transaction.id, {
      ...transactionData(transaction), status: WagerTransactionStatus.FAILED, failureCode: transaction.failureCode,
    }, ctx));
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); Object.freeze(this); }
  static create(props: IntegrationEventProps<WalletBalanceChangedData>): WalletBalanceChanged { return new WalletBalanceChanged(props); }
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (wallet.id !== entry.walletId || !wallet.balance.equals(entry.balanceAfter)) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Balance event must describe the current wallet movement.');
    }
    return this.create(envelope(wallet.id, {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    }, ctx));
  }
}
