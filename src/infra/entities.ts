import { EntitySchema } from 'typeorm';

export interface WalletRecord {
  id: string; playerId: string; currency: string; balance: string; version: number;
  createdAt: Date; updatedAt: Date;
}
export interface TransactionRecord {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  payloadHash: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: string; amount: string; currency: string; status: string;
  referenceExternalTransactionId: string | null; referenceTransactionId: string | null;
  failureCode: string | null; resultBalance: string | null; resultCurrency: string | null; processedAt: Date | null;
  createdAt: Date; attempts: number; nextAttemptAt: Date | null;
}
export interface LedgerRecord {
  id: string; walletId: string; transactionId: string; direction: string; amount: string;
  currency: string; balanceBefore: string; balanceAfter: string; walletVersion: number; createdAt: Date;
}

export const WalletEntity = new EntitySchema<WalletRecord>({
  name: 'WalletRecord', tableName: 'wallets', columns: {
    id: { type: 'uuid', primary: true }, playerId: { name: 'player_id', type: 'uuid' },
    currency: { type: 'varchar', length: 3 }, balance: { type: 'numeric', precision: 38, scale: 2 },
    version: { type: 'integer' }, createdAt: { name: 'created_at', type: 'timestamptz' },
    updatedAt: { name: 'updated_at', type: 'timestamptz' },
  },
});
export const TransactionEntity = new EntitySchema<TransactionRecord>({
  name: 'TransactionRecord', tableName: 'wager_transactions', columns: {
    id: { type: 'uuid', primary: true }, providerId: { name: 'provider_id', type: 'text' },
    externalTransactionId: { name: 'external_transaction_id', type: 'text' },
    idempotencyKey: { name: 'idempotency_key', type: 'text' }, payloadHash: { name: 'payload_hash', type: 'text' },
    walletId: { name: 'wallet_id', type: 'uuid' }, playerId: { name: 'player_id', type: 'uuid' },
    roundId: { name: 'round_id', type: 'text' }, gameId: { name: 'game_id', type: 'text' },
    kind: { type: 'text' }, amount: { type: 'numeric', precision: 38, scale: 2 },
    currency: { type: 'varchar', length: 3 }, status: { type: 'text' },
    referenceExternalTransactionId: { name: 'reference_external_transaction_id', type: 'text', nullable: true },
    referenceTransactionId: { name: 'reference_transaction_id', type: 'uuid', nullable: true },
    failureCode: { name: 'failure_code', type: 'text', nullable: true },
    resultBalance: { name: 'result_balance', type: 'numeric', precision: 38, scale: 2, nullable: true },
    resultCurrency: { name: 'result_currency', type: 'varchar', length: 3, nullable: true },
    processedAt: { name: 'processed_at', type: 'timestamptz', nullable: true },
    createdAt: { name: 'created_at', type: 'timestamptz' }, attempts: { type: 'integer' },
    nextAttemptAt: { name: 'next_attempt_at', type: 'timestamptz', nullable: true },
  },
});
export const LedgerEntity = new EntitySchema<LedgerRecord>({
  name: 'LedgerRecord', tableName: 'wallet_ledger', columns: {
    id: { type: 'uuid', primary: true }, walletId: { name: 'wallet_id', type: 'uuid' },
    transactionId: { name: 'transaction_id', type: 'uuid' }, direction: { type: 'text' },
    amount: { type: 'numeric', precision: 38, scale: 2 }, currency: { type: 'varchar', length: 3 },
    balanceBefore: { name: 'balance_before', type: 'numeric', precision: 38, scale: 2 },
    balanceAfter: { name: 'balance_after', type: 'numeric', precision: 38, scale: 2 },
    walletVersion: { name: 'wallet_version', type: 'integer' }, createdAt: { name: 'created_at', type: 'timestamptz' },
  },
});
