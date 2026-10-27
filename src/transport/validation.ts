import { ApplicationError, type OpenWalletInput, type SubmitTransactionInput } from '../application/contracts';
import { Money } from '../domain/money';

export function invalid(message: string): never { throw new ApplicationError('INVALID_REQUEST', message, 400); }
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a JSON object.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) invalid('Unknown field in request.');
  return record;
}
export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid(`${field} must be a UUID.`);
  return value.toLowerCase();
}
export function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) invalid(`${field} must be an identifier of 1 to 128 characters.`);
  return value;
}
export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) invalid('Idempotency-Key is required and must contain 1 to 256 visible ASCII characters.');
  return value;
}
function money(value: unknown): { amount: string; currency: string } {
  const data = object(value, ['amount', 'currency']);
  if (typeof data.amount !== 'string' || typeof data.currency !== 'string') invalid('Money requires string amount and currency.');
  return Money.from({ amount: data.amount, currency: data.currency }).toJSON();
}
export function parseOpenWallet(value: unknown): OpenWalletInput {
  const data = object(value, ['playerId', 'initialBalance']);
  return { playerId: uuid(data.playerId, 'playerId'), initialBalance: money(data.initialBalance) };
}
export function parseSubmit(value: unknown, headerKey?: unknown, fromQueue = false): SubmitTransactionInput {
  const allowed = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId'];
  if (fromQueue) allowed.push('idempotencyKey');
  const data = object(value, allowed);
  const kind = data.kind;
  if (kind !== 'BET' && kind !== 'WIN' && kind !== 'LOSS' && kind !== 'REFUND' && kind !== 'ROLLBACK') invalid('Invalid public transaction kind.');
  const result: SubmitTransactionInput = {
    providerId: identifier(data.providerId, 'providerId'),
    externalTransactionId: identifier(data.externalTransactionId, 'externalTransactionId'),
    idempotencyKey: idempotencyKey(fromQueue ? data.idempotencyKey : headerKey),
    playerId: uuid(data.playerId, 'playerId'), walletId: uuid(data.walletId, 'walletId'),
    roundId: identifier(data.roundId, 'roundId'), gameId: identifier(data.gameId, 'gameId'),
    kind, money: money(data.money),
  };
  if (data.referenceExternalTransactionId !== undefined) result.referenceExternalTransactionId = identifier(data.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && !result.referenceExternalTransactionId) invalid('A referenceExternalTransactionId is required.');
  return result;
}
export interface RequestedMessage { messageId: string; type: 'WagerTransactionRequested'; occurredAt: string; correlationId?: string; data: SubmitTransactionInput }
export function parseRequestedMessage(body: string): RequestedMessage {
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024) invalid('Message exceeds 64 KiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { invalid('Malformed JSON message.'); }
  const data = object(parsed, ['messageId', 'type', 'occurredAt', 'correlationId', 'data']);
  if (data.type !== 'WagerTransactionRequested') invalid('Unsupported message type.');
  if (typeof data.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.occurredAt) || !Number.isFinite(Date.parse(data.occurredAt))) invalid('occurredAt must be an ISO-8601 UTC timestamp.');
  if (new Date(data.occurredAt).toISOString().replace(/\.\d{3}Z$/, 'Z') !== data.occurredAt.replace(/\.\d{1,3}Z$/, 'Z')) invalid('occurredAt must be a valid calendar date.');
  return {
    messageId: identifier(data.messageId, 'messageId'), type: data.type, occurredAt: data.occurredAt,
    ...(data.correlationId === undefined ? {} : { correlationId: identifier(data.correlationId, 'correlationId') }),
    data: parseSubmit(data.data, undefined, true),
  };
}
export function parseLedgerQuery(query: unknown): { cursor?: string; limit: number } {
  const data = object(query, ['cursor', 'limit']);
  if (data.cursor !== undefined && (typeof data.cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(data.cursor))) invalid('Invalid ledger cursor.');
  if (data.limit !== undefined && (typeof data.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(data.limit))) invalid('limit must be an integer between 1 and 100.');
  const limit = data.limit === undefined ? 50 : Number(data.limit);
  if (limit > 100) invalid('limit must be an integer between 1 and 100.');
  return { cursor: data.cursor as string | undefined, limit };
}
