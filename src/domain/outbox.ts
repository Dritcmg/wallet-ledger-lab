import { copyDate, DomainError } from './errors';
import { immutableJsonSnapshot, IntegrationEvent } from './events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  static readonly RETRY_BASE_MS = 1_000;
  static readonly RETRY_MAX_MS = 60_000;

  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  private readonly _occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;
  private _publishedAt: Date | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = immutableJsonSnapshot(state.payload);
    this._occurredAt = copyDate(state.occurredAt);
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt === undefined ? undefined : copyDate(state.nextAttemptAt);
    this._publishedAt = state.publishedAt === undefined ? undefined : copyDate(state.publishedAt);
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: { ...event.toJSON() }, occurredAt: event.occurredAt, attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage { return new OutboxMessage(state); }
  get occurredAt(): Date { return copyDate(this._occurredAt); }
  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt === undefined ? undefined : copyDate(this._nextAttemptAt); }
  get publishedAt(): Date | undefined { return this._publishedAt === undefined ? undefined : copyDate(this._publishedAt); }
  isPending(): boolean { return this._publishedAt === undefined; }

  isDue(now: Date): boolean {
    const at = copyDate(now);
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= at.getTime());
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = copyDate(at);
    this._nextAttemptAt = undefined;
  }

  /** Deterministic, capped exponential retry. Publishers own SQL leases and transport retry policy. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    const timestamp = copyDate(now).getTime();
    const delay = Math.min(OutboxMessage.RETRY_BASE_MS * 2 ** Math.min(this._attempts, 6), OutboxMessage.RETRY_MAX_MS);
    this._attempts += 1;
    this._nextAttemptAt = new Date(timestamp + delay);
  }

  private assertPending(): void {
    if (!this.isPending()) throw new DomainError('OUTBOX_ALREADY_PUBLISHED', 'A published message cannot be changed.');
  }
}
