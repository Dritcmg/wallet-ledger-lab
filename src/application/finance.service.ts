import { randomUUID } from 'node:crypto';
import { type EntityManager } from 'typeorm';
import {
  DomainError, Money, Wallet, WagerTransaction, WagerTransactionKind, WagerTransactionStatus,
  WalletLedgerEntry, LedgerDirection, WagerTransactionProcessed, WagerTransactionRejected,
  WagerTransactionPendingReference, WagerTransactionFailed, WalletBalanceChanged, InboxMessage, OutboxMessage, type IntegrationEvent,
} from '../domain';
import { Database } from '../infra/database';
import { WalletEntity, TransactionEntity, LedgerEntity, type WalletRecord, type TransactionRecord } from '../infra/entities';
import { metrics, logger } from '../infra/observability';
import { config } from '../config';
import { ApplicationError, type SubmitTransactionInput, type ProcessingContext, type TransactionResult, type OpenWalletInput, type WalletView } from './contracts';
import { sha256 } from './hash';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
const TERMINAL = ['PROCESSED', 'REJECTED', 'FAILED'];
function assertUuid(value: string, name: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApplicationError('INVALID_PAYLOAD', `${name} must be a UUID`);
}
function assertIdentifier(value: string, name: string, max = 128): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApplicationError('INVALID_PAYLOAD', `Invalid ${name}`);
  }
}
function dbCode(error: unknown): string | undefined { return (error as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (error as { code?: string })?.code; }

export class FinanceService {
  constructor(private readonly db: Database) {}

  async openWallet(input: OpenWalletInput, correlationId: string = randomUUID()): Promise<WalletView> {
    assertUuid(input.playerId, 'playerId');
    const money = Money.from(input.initialBalance);
    const now = new Date();
    const wallet = Wallet.open({ id: randomUUID(), playerId: input.playerId, initialBalance: money, at: now });
    try {
      return await this.db.transaction(async manager => {
        await manager.insert(WalletEntity, this.walletRecord(wallet));
        if (money.isPositive()) {
          const id = randomUUID();
          const transaction = WagerTransaction.create({
            id, providerId: '__internal__', externalTransactionId: `opening:${wallet.id}`, idempotencyKey: `__opening__:${wallet.id}`,
            payloadHash: sha256({ playerId: wallet.playerId, initialBalance: money.toJSON() }), walletId: wallet.id,
            playerId: wallet.playerId, roundId: 'OPENING', gameId: 'OPENING', kind: WagerTransactionKind.OPENING, money, createdAt: now,
          });
          transaction.markProcessed(undefined, now);
          await manager.insert(TransactionEntity, this.transactionRecord(transaction, wallet));
          const entry = WalletLedgerEntry.create({ id: randomUUID(), walletId: wallet.id, transactionId: id,
            direction: LedgerDirection.CREDIT, money, balanceBefore: Money.zero(wallet.currency), balanceAfter: money, createdAt: now });
          await this.writeLedger(manager, wallet, entry);
          await this.enqueue(manager, WagerTransactionProcessed.from(transaction, { eventId: randomUUID(), correlationId, occurredAt: now }));
          await this.enqueue(manager, WalletBalanceChanged.from(wallet, entry, { eventId: randomUUID(), correlationId, occurredAt: now }));
        }
        return this.walletView(wallet);
      });
    } catch (error) {
      if (dbCode(error) === '23505') throw new ApplicationError('WALLET_EXISTS', 'Player already has a wallet in this currency', 409);
      throw error;
    }
  }

  async getWallet(id: string): Promise<WalletView> {
    assertUuid(id, 'walletId');
    const row = await this.db.dataSource.manager.findOne(WalletEntity, { where: { id } });
    if (!row) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet not found', 404);
    return this.walletView(this.walletDomain(row));
  }

  async getLedger(id: string, cursor?: string, limit = 50): Promise<{ items: unknown[]; nextCursor: string | null }> {
    await this.getWallet(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApplicationError('INVALID_PAGINATION', 'limit must be between 1 and 100');
    let after = 0;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { v: number; walletId: string; version: number };
        if (parsed.v !== 1 || parsed.walletId !== id || !Number.isSafeInteger(parsed.version) || parsed.version < 1) throw new Error();
        after = parsed.version;
      } catch { throw new ApplicationError('INVALID_CURSOR', 'Invalid ledger cursor'); }
    }
    const rows = await this.db.dataSource.manager.getRepository(LedgerEntity).createQueryBuilder('entry')
      .where('entry.walletId = :id AND entry.walletVersion > :after', { id, after })
      .orderBy('entry.walletVersion', 'ASC').take(limit + 1).getMany();
    const page = rows.slice(0, limit);
    return {
      items: page.map(row => ({ id: row.id, walletId: row.walletId, transactionId: row.transactionId, direction: row.direction,
        money: { amount: row.amount, currency: row.currency }, balanceBefore: { amount: row.balanceBefore, currency: row.currency },
        balanceAfter: { amount: row.balanceAfter, currency: row.currency }, walletVersion: row.walletVersion, createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ v: 1, walletId: id, version: page.at(-1)!.walletVersion })).toString('base64url') : null,
    };
  }

  async getTransaction(id: string): Promise<TransactionResult & { providerId: string; externalTransactionId: string; kind: string }> {
    assertUuid(id, 'transactionId');
    const row = await this.db.dataSource.manager.findOne(TransactionEntity, { where: { id } });
    if (!row) throw new ApplicationError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    return { ...this.result(row, false), providerId: row.providerId, externalTransactionId: row.externalTransactionId, kind: row.kind };
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string): Promise<TransactionResult> {
    assertIdentifier(providerId, 'providerId'); assertIdentifier(externalTransactionId, 'externalTransactionId');
    const row = await this.db.dataSource.manager.findOne(TransactionEntity, { where: { providerId, externalTransactionId } });
    if (!row) throw new ApplicationError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    return this.result(row, false);
  }

  async reconcile(id: string): Promise<unknown> {
    assertUuid(id, 'walletId');
    return this.db.transaction(async manager => {
      // The shared lock blocks financial writers for this wallet while both readings are taken.
      const row = await manager.findOne(WalletEntity, { where: { id }, lock: { mode: 'pessimistic_read' } });
      if (!row) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet not found', 404);
      const [totals] = await manager.query(`SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::numeric(38,2)::text AS balance,
        count(*)::integer AS entries FROM wallet_ledger WHERE wallet_id=$1`, [id]) as { balance: string; entries: number }[];
      const stored = Money.from({ amount: row.balance, currency: row.currency });
      const calculated = Money.rehydrate({ amount: totals!.balance, currency: row.currency });
      const consistent = stored.equals(calculated);
      if (!consistent) { metrics.increment('wager_reconciliation_mismatches_total'); logger.error('reconciliation_mismatch', { walletId: id }); }
      return { walletId: id, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(),
        difference: stored.subtract(calculated).toJSON(), consistent, checkedEntries: totals!.entries };
    });
  }

  async submit(input: SubmitTransactionInput, context: ProcessingContext = {}): Promise<TransactionResult> {
    this.validate(input);
    const correlationId = context.correlationId ?? randomUUID();
    const started = performance.now();
    const hash = sha256(this.businessPayload(input));
    // Validates contract and reference presence before allocating a database transaction.
    const newTransaction = WagerTransaction.create({ ...input, id: randomUUID(), payloadHash: hash,
      kind: input.kind as WagerTransactionKind, money: Money.from(input.money) });
    try {
      const result = await this.withRetry(() => this.db.transaction(async manager => {
        const walletRow = await manager.findOne(WalletEntity, { where: { id: input.walletId }, lock: { mode: 'pessimistic_write' } });
        if (!walletRow) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet not found', 404);
        const wallet = this.walletDomain(walletRow);
        if (context.inbox) {
          const [inbox] = await manager.query('SELECT payload_hash, transaction_id FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2',
            [context.inbox.consumerName, context.inbox.messageId]) as { payload_hash: string; transaction_id: string }[];
          if (inbox) {
            if (inbox.payload_hash !== context.inbox.payloadHash) throw new ApplicationError('MESSAGE_CONFLICT', 'Message identifier reused with different contents', 409);
            const previous = await manager.findOneOrFail(TransactionEntity, { where: { id: inbox.transaction_id } });
            return this.result(previous, true);
          }
        }
        const existing = await manager.findOne(TransactionEntity, { where: { idempotencyKey: input.idempotencyKey } });
        if (existing) {
          if (existing.payloadHash !== hash) throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'Key reused with a different business payload', 409);
          await this.recordInbox(manager, context, existing.id);
          return this.result(existing, true);
        }
        const sameExternal = await manager.findOne(TransactionEntity, { where: { providerId: input.providerId, externalTransactionId: input.externalTransactionId } });
        if (sameExternal) throw new ApplicationError('EXTERNAL_TRANSACTION_CONFLICT', 'External operation already has a different idempotency key', 409);
        // Clone on each SQL retry: domain entities are mutable state machines and cannot be reused after a rolled-back attempt.
        const transaction = WagerTransaction.rehydrate({ ...input, id: newTransaction.id, payloadHash: hash,
          kind: input.kind as WagerTransactionKind, money: Money.from(input.money), createdAt: newTransaction.createdAt, status: WagerTransactionStatus.PENDING });
        const row = this.transactionRecord(transaction, wallet);
        await manager.insert(TransactionEntity, row);
        await this.apply(manager, wallet, transaction, row, correlationId);
        await this.recordInbox(manager, context, transaction.id);
        return this.result(row, false);
      }));
      metrics.increment('wager_transaction_responses_total', { status: result.status });
      if (result.idempotentReplay) metrics.increment('wager_duplicates_total', { source: context.inbox ? 'sqs' : 'http' });
      logger.info('transaction_result', { correlationId, transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId, status: result.status });
      return result;
    } finally { metrics.observe('wager_processing_duration_seconds', (performance.now() - started) / 1000); }
  }

  async retryPendingReferences(limit = 20): Promise<number> {
    const candidates = await this.db.dataSource.query(`SELECT id, wallet_id FROM wager_transactions WHERE status='PENDING_REFERENCE'
      AND next_attempt_at <= now() ORDER BY next_attempt_at,id LIMIT $1`, [limit]) as { id: string; wallet_id: string }[];
    let handled = 0;
    for (const candidate of candidates) {
      handled += await this.withRetry(() => this.db.transaction(async manager => {
        const walletRow = await manager.findOneOrFail(WalletEntity, { where: { id: candidate.wallet_id }, lock: { mode: 'pessimistic_write' } });
        const row = await manager.findOneOrFail(TransactionEntity, { where: { id: candidate.id } });
        if (row.status !== 'PENDING_REFERENCE' || !row.nextAttemptAt || row.nextAttemptAt > new Date()) return 0;
        row.attempts += 1;
        await this.apply(manager, this.walletDomain(walletRow), this.transactionDomain(row), row, randomUUID(), true);
        metrics.increment('wager_reference_retries_total');
        return 1;
      }));
    }
    return handled;
  }

  async failPendingTransaction(input: SubmitTransactionInput, code: string): Promise<void> {
    this.validate(input);
    const hash = sha256(this.businessPayload(input));
    await this.db.transaction(async manager => {
      const wallet = await manager.findOne(WalletEntity, { where: { id: input.walletId }, lock: { mode: 'pessimistic_write' } });
      if (!wallet) return;
      let row = await manager.findOne(TransactionEntity, { where: { idempotencyKey: input.idempotencyKey } });
      if (row && (row.walletId !== input.walletId || row.payloadHash !== hash || TERMINAL.includes(row.status))) return;
      if (!row) {
        const external = await manager.findOne(TransactionEntity, { where: { providerId: input.providerId, externalTransactionId: input.externalTransactionId } });
        if (external) return;
        const transaction = WagerTransaction.create({ ...input, id: randomUUID(), payloadHash: hash,
          kind: input.kind as WagerTransactionKind, money: Money.from(input.money) });
        row = this.transactionRecord(transaction, this.walletDomain(wallet));
        await manager.insert(TransactionEntity, row);
      }
      const domain = this.transactionDomain(row);
      domain.fail(code);
      Object.assign(row, { status: domain.status, failureCode: code, resultBalance: wallet.balance, resultCurrency: wallet.currency, processedAt: new Date(), nextAttemptAt: null });
      await manager.update(TransactionEntity, { id: row.id }, row);
      await this.enqueue(manager, WagerTransactionFailed.from(domain, { eventId: randomUUID(), correlationId: domain.id }));
    });
  }

  private async apply(manager: EntityManager, wallet: Wallet, transaction: WagerTransaction, row: TransactionRecord,
    correlationId: string, retrying = false): Promise<void> {
    const now = new Date();
    const eventContext = () => ({ eventId: randomUUID(), correlationId, causationId: transaction.id, occurredAt: now });
    let reference: WagerTransaction | undefined;
    try {
      if (wallet.playerId !== transaction.playerId) throw new DomainError('PLAYER_MISMATCH', 'Wallet belongs to another player');
      if (wallet.currency !== transaction.money.currency) throw new DomainError('CURRENCY_MISMATCH', 'Transaction currency differs from wallet');
      if (transaction.referenceExternalTransactionId) {
        const referenceRow = await manager.findOne(TransactionEntity, { where: {
          providerId: transaction.providerId, externalTransactionId: transaction.referenceExternalTransactionId,
        } });
        if (referenceRow && (referenceRow.walletId !== transaction.walletId || referenceRow.playerId !== transaction.playerId ||
          referenceRow.roundId !== transaction.roundId || referenceRow.currency !== transaction.money.currency)) {
          throw new DomainError('REFERENCE_MISMATCH', 'Reference belongs to another wallet, player, currency or round');
        }
        if (!referenceRow || !TERMINAL.includes(referenceRow.status)) {
          const expired = row.attempts >= config.referenceMaxAttempts || now.getTime() - row.createdAt.getTime() >= config.referenceTtlSeconds * 1000;
          if (expired) throw new DomainError('REFERENCE_NOT_FOUND', 'Reference did not become available within the retry budget');
          transaction.markPendingReference();
          row.status = transaction.status;
          row.nextAttemptAt = new Date(now.getTime() + Math.min(config.referenceRetryBaseMs * 2 ** Math.min(row.attempts, 10), 60000));
          await manager.update(TransactionEntity, { id: row.id }, row);
          if (!retrying) await this.enqueue(manager, WagerTransactionPendingReference.from(transaction, eventContext()));
          return;
        }
        reference = this.transactionDomain(referenceRow);
        transaction.validateReference(reference);
        if (transaction.kind === WagerTransactionKind.REFUND || transaction.kind === WagerTransactionKind.ROLLBACK) {
          const previous = await manager.findOne(TransactionEntity, { where: { referenceTransactionId: reference.id, kind: transaction.kind, status: 'PROCESSED' } });
          if (previous) throw new DomainError('REFERENCE_ALREADY_REVERSED', 'Reference has already been reversed by this operation kind');
        }
      }
      let entry: WalletLedgerEntry | undefined;
      if (transaction.affectsBalance()) {
        const direction = transaction.ledgerDirectionFor(reference);
        if (direction === LedgerDirection.DEBIT && wallet.balance.isLessThan(transaction.money)) {
          throw new DomainError(transaction.kind === WagerTransactionKind.ROLLBACK ? 'INSUFFICIENT_FUNDS_FOR_REVERSAL' : 'INSUFFICIENT_FUNDS', 'Debit would produce a negative balance');
        }
        const movement = direction === LedgerDirection.DEBIT ? wallet.debit(transaction.money, now) : wallet.credit(transaction.money, now);
        entry = WalletLedgerEntry.create({ id: randomUUID(), walletId: wallet.id, transactionId: transaction.id,
          direction, money: transaction.money, ...movement, createdAt: now });
      }
      transaction.markProcessed(reference?.id, now);
      Object.assign(row, { status: transaction.status, referenceTransactionId: reference?.id ?? null, resultBalance: wallet.balance.toString(),
        resultCurrency: wallet.currency, processedAt: now, failureCode: null, nextAttemptAt: null });
      await manager.update(TransactionEntity, { id: row.id }, row);
      if (entry) {
        await manager.update(WalletEntity, { id: wallet.id }, { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt });
        await this.writeLedger(manager, wallet, entry);
        await this.enqueue(manager, WalletBalanceChanged.from(wallet, entry, eventContext()));
      }
      await this.enqueue(manager, WagerTransactionProcessed.from(transaction, eventContext()));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      transaction.reject(error.code);
      Object.assign(row, { status: transaction.status, failureCode: error.code, resultBalance: wallet.balance.toString(),
        resultCurrency: wallet.currency, processedAt: now, nextAttemptAt: null });
      await manager.update(TransactionEntity, { id: row.id }, row);
      await this.enqueue(manager, WagerTransactionRejected.from(transaction, eventContext()));
    }
  }

  private async recordInbox(manager: EntityManager, context: ProcessingContext, transactionId: string): Promise<void> {
    if (!context.inbox) return;
    const message = InboxMessage.receive(context.inbox);
    message.markProcessed(new Date());
    await manager.query(`INSERT INTO inbox_messages(consumer_name,message_id,payload_hash,transaction_id,received_at,processed_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [message.consumerName, message.messageId, message.payloadHash, transactionId, message.receivedAt, message.processedAt]);
  }
  private async enqueue(manager: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    await manager.query(`INSERT INTO outbox_messages(id,aggregate_id,event_type,payload,occurred_at) VALUES($1,$2,$3,$4::jsonb,$5)`,
      [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload), message.occurredAt]);
  }
  private async writeLedger(manager: EntityManager, wallet: Wallet, entry: WalletLedgerEntry): Promise<void> {
    await manager.insert(LedgerEntity, { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
      direction: entry.direction, amount: entry.money.toString(), currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(), walletVersion: wallet.version, createdAt: entry.createdAt });
  }
  private walletDomain(row: WalletRecord): Wallet { return Wallet.rehydrate({ ...row, balance: Money.from({ amount: row.balance, currency: row.currency }) }); }
  private walletRecord(wallet: Wallet): WalletRecord { return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
    balance: wallet.balance.toString(), version: wallet.version, createdAt: wallet.createdAt, updatedAt: wallet.updatedAt }; }
  private walletView(wallet: Wallet): WalletView { return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version }; }
  private transactionRecord(transaction: WagerTransaction, wallet: Wallet): TransactionRecord {
    return { id: transaction.id, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey, payloadHash: transaction.payloadHash, walletId: transaction.walletId,
      playerId: transaction.playerId, roundId: transaction.roundId, gameId: transaction.gameId, kind: transaction.kind,
      amount: transaction.money.toString(), currency: transaction.money.currency, status: transaction.status,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null, referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null, resultBalance: wallet.balance.toString(), resultCurrency: wallet.currency,
      processedAt: transaction.processedAt ?? null, createdAt: transaction.createdAt, attempts: 0, nextAttemptAt: null };
  }
  private transactionDomain(row: TransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({ ...row, kind: row.kind as WagerTransactionKind, status: row.status as WagerTransactionStatus,
      money: Money.from({ amount: row.amount, currency: row.currency }), referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: row.referenceTransactionId ?? undefined, failureCode: row.failureCode ?? undefined, processedAt: row.processedAt ?? undefined });
  }
  private result(row: TransactionRecord, replay: boolean): TransactionResult {
    return { transactionId: row.id, walletId: row.walletId, status: row.status as TransactionResult['status'],
      balance: { amount: row.resultBalance ?? '0.00', currency: row.resultCurrency ?? row.currency }, idempotentReplay: replay,
      ...(row.failureCode ? { failureCode: row.failureCode } : {}) };
  }
  private businessPayload(input: SubmitTransactionInput): unknown {
    return { providerId: input.providerId, externalTransactionId: input.externalTransactionId, playerId: input.playerId,
      walletId: input.walletId, roundId: input.roundId, gameId: input.gameId, kind: input.kind, money: Money.from(input.money).toJSON(),
      ...(input.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: input.referenceExternalTransactionId }) };
  }
  private validate(input: SubmitTransactionInput): void {
    if (!input || typeof input !== 'object') throw new ApplicationError('INVALID_PAYLOAD', 'Object required');
    assertUuid(input.walletId, 'walletId'); assertUuid(input.playerId, 'playerId');
    for (const field of ['providerId','externalTransactionId','roundId','gameId'] as const) assertIdentifier(input[field], field);
    assertIdentifier(input.idempotencyKey, 'idempotencyKey', 256);
    if (input.providerId === '__internal__' || input.idempotencyKey.startsWith('__opening__:')) throw new ApplicationError('INVALID_PROVIDER', 'Reserved internal identity');
    if (!PUBLIC_KINDS.includes(input.kind)) throw new ApplicationError('INVALID_KIND', 'Only public wagering operations are allowed');
    if (input.referenceExternalTransactionId !== undefined) assertIdentifier(input.referenceExternalTransactionId, 'referenceExternalTransactionId');
    Money.from(input.money);
  }
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); } catch (error) {
        const code = dbCode(error);
        if (!code || !['40001','40P01','23505','55P03'].includes(code) || attempt >= 3) throw error;
        metrics.increment('wager_lock_conflicts_total', { code });
        await Bun.sleep(10 * 2 ** attempt);
      }
    }
  }
}
