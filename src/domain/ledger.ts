import { assertNonEmpty, copyDate, DomainError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}
export type CreateLedgerEntryProps = Omit<LedgerEntryState, 'createdAt'> & { createdAt?: Date };

export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this._createdAt = copyDate(createdAt);
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.walletId, 'walletId');
    assertNonEmpty(props.transactionId, 'transactionId');
    if (!props.money.isPositive() || props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger amounts must be positive and balances nonnegative.');
    }
    if (props.direction !== LedgerDirection.DEBIT && props.direction !== LedgerDirection.CREDIT) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger direction must be DEBIT or CREDIT.');
    }
    const entry = WalletLedgerEntry.rehydrate({ ...props, createdAt: props.createdAt ?? new Date() });
    if (!entry.isBalanced()) throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger entry does not reconcile.');
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state.id, state.walletId, state.transactionId, state.direction, state.money, state.balanceBefore, state.balanceAfter, state.createdAt);
  }

  get createdAt(): Date { return copyDate(this._createdAt); }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.DEBIT
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
