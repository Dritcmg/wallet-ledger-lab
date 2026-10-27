import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { Database } from '../infra/database';
import { logger, metrics } from '../infra/observability';
import { SqsBroker, type PublishableEvent } from '../infra/sqs';
import { backoffSeconds, PeriodicWorker } from './lifecycle';

interface ClaimedMessage {
  id: string; aggregate_id: string; payload: PublishableEvent; occurred_at: Date | string;
  attempts: number; claim_token: string;
}

export class OutboxPublisher extends PeriodicWorker {
  protected readonly workerName = 'outbox';
  constructor(private readonly db: Database, private readonly broker: SqsBroker) { super(); }

  async runOnce(): Promise<number> {
    const token = randomUUID();
    // The short claiming transaction commits before any network publication starts.
    const claimed = await this.db.transaction(manager => manager.query<ClaimedMessage[] | [ClaimedMessage[], number]>(`
      WITH due AS (
        SELECT id FROM outbox_messages
        WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY occurred_at, id FOR UPDATE SKIP LOCKED LIMIT 10
      )
      UPDATE outbox_messages AS o
      SET claim_token = $1, locked_until = now() + ($2 * interval '1 second'), attempts = o.attempts + 1
      FROM due WHERE o.id = due.id
      RETURNING o.id, o.aggregate_id, o.payload, o.occurred_at, o.attempts, o.claim_token
    `, [token, config.outboxLeaseSeconds]));
    // TypeORM's PostgreSQL driver returns [rows, affectedCount] for UPDATE RETURNING,
    // even when the statement begins with a WITH clause.
    const messages: ClaimedMessage[] = Array.isArray(claimed[0]) ? claimed[0] : claimed as ClaimedMessage[];
    const outcomes = await Promise.allSettled(messages.map(message => this.publish(message)));
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('Outbox persistence unavailable.');
    return messages.length;
  }

  private async publish(message: ClaimedMessage): Promise<void> {
    const renew = setInterval(() => {
      void this.db.transaction(manager => manager.query(`
        UPDATE outbox_messages SET locked_until = now() + ($3 * interval '1 second')
        WHERE id = $1 AND claim_token = $2 AND published_at IS NULL
      `, [message.id, message.claim_token, config.outboxLeaseSeconds])).catch(() => {
        logger.error('outbox_lease_renewal_failed', { eventId: message.id, code: 'INFRASTRUCTURE_UNAVAILABLE' });
      });
    }, Math.max(250, Math.floor(config.outboxLeaseSeconds * 1000 / 3)));
    try {
      await this.broker.publishEvent(message.payload);
      // Losing a lease must never mark another publisher's claim as published.
      await this.db.transaction(manager => manager.query(`
        UPDATE outbox_messages SET published_at = now(), locked_until = NULL, claim_token = NULL
        WHERE id = $1 AND claim_token = $2 AND published_at IS NULL
      `, [message.id, message.claim_token]));
      metrics.increment('wager_outbox_published_total');
      metrics.observe('wager_outbox_lag_seconds', Math.max(0, (Date.now() - new Date(message.occurred_at).getTime()) / 1000));
      const data = message.payload.data as Record<string, unknown> | undefined;
      logger.info('outbox_event_published', {
        eventId: message.id, correlationId: message.payload.correlationId,
        walletId: data?.walletId, transactionId: data?.transactionId, providerId: data?.providerId,
      });
    } catch {
      const delaySeconds = backoffSeconds(message.attempts);
      await this.db.transaction(manager => manager.query(`
        UPDATE outbox_messages SET next_attempt_at = now() + ($3 * interval '1 second'),
          locked_until = NULL, claim_token = NULL
        WHERE id = $1 AND claim_token = $2 AND published_at IS NULL
      `, [message.id, message.claim_token, delaySeconds]));
      metrics.increment('wager_retries_total', { worker: 'outbox' });
      logger.error('outbox_publish_retry', { eventId: message.id, attempt: message.attempts, delaySeconds, code: 'PUBLISH_FAILED' });
    } finally { clearInterval(renew); }
  }
}
