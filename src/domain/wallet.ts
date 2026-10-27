import { assertNonEmpty, copyDate, CurrencyMismatchError, DomainError, InsufficientFundsError } from './errors';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

export class Wallet {
  private readonly _createdAt: Date;
  private _updatedAt: Date;
  private _balance: Money;
  private _version: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._balance = balance;
    this._version = version;
    this._createdAt = copyDate(createdAt);
    this._updatedAt = copyDate(updatedAt);
  }

  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.playerId, 'playerId');
    if (props.initialBalance.isNegative()) {
      throw new DomainError('INVALID_AMOUNT', 'Initial balance cannot be negative.');
    }
    const at = props.at ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, at, at);
  }

  /** Reconstruct persisted state without replaying opening or movement rules. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get createdAt(): Date { return copyDate(this._createdAt); }
  get updatedAt(): Date { return copyDate(this._updatedAt); }

  debit(money: Money, at: Date = new Date()): WalletMovement {
    this.assertMovement(money);
    if (this._balance.isLessThan(money)) throw new InsufficientFundsError();
    return this.apply(this._balance.subtract(money), at);
  }

  credit(money: Money, at: Date = new Date()): WalletMovement {
    this.assertMovement(money);
    return this.apply(this._balance.add(money), at);
  }

  private apply(balanceAfter: Money, at: Date): WalletMovement {
    // Validate timestamp before mutating any aggregate state.
    const updatedAt = copyDate(at);
    const balanceBefore = this._balance;
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = updatedAt;
    return Object.freeze({ balanceBefore, balanceAfter });
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError();
    if (!money.isPositive()) throw new DomainError('INVALID_AMOUNT', 'A wallet movement must be positive.');
  }
}
