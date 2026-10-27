import type { MoneyProps } from '../domain';

export type PublicKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export interface SubmitTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: PublicKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface ProcessingContext {
  correlationId?: string;
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}
export interface TransactionResult {
  transactionId: string;
  walletId: string;
  status: 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}
export interface OpenWalletInput { playerId: string; initialBalance: MoneyProps }
export interface WalletView {
  id: string; playerId: string; balance: MoneyProps; version: number;
}
export class ApplicationError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus: number = 400) {
    super(message); this.name = 'ApplicationError';
  }
}
