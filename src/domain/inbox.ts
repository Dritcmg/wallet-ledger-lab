import { assertNonEmpty, copyDate } from './errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}
export interface InboxMessageState extends Omit<ReceiveInboxProps, 'receivedAt'> {
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private readonly _receivedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
  ) {
    this._receivedAt = copyDate(receivedAt);
    this._processedAt = processedAt === undefined ? undefined : copyDate(processedAt);
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, 'messageId');
    assertNonEmpty(props.consumerName, 'consumerName');
    assertNonEmpty(props.payloadHash, 'payloadHash');
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt ?? new Date());
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get receivedAt(): Date { return copyDate(this._receivedAt); }
  get processedAt(): Date | undefined { return this._processedAt === undefined ? undefined : copyDate(this._processedAt); }
  isProcessed(): boolean { return this._processedAt !== undefined; }

  markProcessed(at: Date): void {
    // A replay must retain the original observed completion time.
    if (!this.isProcessed()) this._processedAt = copyDate(at);
  }
}
