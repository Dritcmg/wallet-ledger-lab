import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost, Body, CanActivate, Catch, Controller, ExecutionContext, ExceptionFilter,
  Get, Headers, HttpCode, HttpException, Inject, Injectable, Module, Param, Post, Query, Req, Res, UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, type Request, type Response, type NextFunction } from 'express';
import { FinanceService } from '../application/finance.service';
import { ApplicationError, type TransactionResult } from '../application/contracts';
import { DomainError } from '../domain/errors';
import { Database } from '../infra/database';
import { SqsBroker } from '../infra/sqs';
import { logger, metrics, refreshDatabaseMetrics } from '../infra/observability';
import { identifier, parseLedgerQuery, parseOpenWallet, parseSubmit, uuid } from './validation';

export const PROVIDER_IDENTITY = Symbol('ProviderIdentityPort');
export interface ProviderIdentityPort { authorize(request: Request): Promise<void> }
/** Local laboratory adapter. Replace with an external OIDC identity/authorization adapter. */
export class LocalProviderIdentity implements ProviderIdentityPort {
  async authorize(_request: Request): Promise<void> { /* Intentionally unauthenticated local environment. */ }
}
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.identity.authorize(context.switchToHttp().getRequest<Request>());
    return true;
  }
}

interface CorrelatedRequest extends Request { correlationId: string }

function infrastructureUnavailable(error: object): boolean {
  const connectionMessages = new Set([
    'Driver not Connected', 'Connection terminated', 'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect',
  ]);
  let current: unknown = error;
  // PostgreSQL errors may be wrapped by QueryFailedError or a pool connection error.
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const detail = current as { code?: unknown; name?: unknown; message?: unknown; driverError?: unknown; cause?: unknown };
    if (typeof detail.code === 'string' && /^(08|40|53|57P|55P03$|57014$|ECONN|EHOST|ENET|ENOTFOUND$|EAI_AGAIN$|EPIPE$|ETIMEDOUT$)/.test(detail.code)) return true;
    if (detail.name === 'QueryRunnerAlreadyReleasedError' || detail.name === 'CannotExecuteNotConnectedError') return true;
    if (typeof detail.message === 'string' && connectionMessages.has(detail.message)) return true;
    current = detail.driverError ?? detail.cause;
  }
  return false;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<CorrelatedRequest>();
    const response = http.getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    if (error instanceof ApplicationError) {
      status = error.httpStatus; code = error.code; message = error.message;
    } else if (error instanceof DomainError) {
      status = error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400;
      code = error.code; message = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus(); code = status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
      message = status < 500 ? error.message : 'Service temporarily unavailable.';
    } else if (error && typeof error === 'object') {
      const detail = error as { type?: string; status?: number };
      if (detail.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request exceeds 64 KiB.'; }
      else if (detail.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Malformed JSON body.'; }
      else if (infrastructureUnavailable(error)) {
        status = 503; code = 'INFRASTRUCTURE_UNAVAILABLE'; message = 'Service temporarily unavailable; retry the same idempotency key.';
      }
    }
    if (status >= 500) logger.error('http_request_failed', { correlationId: request.correlationId, code, httpStatus: status });
    response.status(status).json({ error: { code, message }, correlationId: request.correlationId });
  }
}

export function transactionHttpStatus(result: TransactionResult): number {
  if (result.status === 'PENDING' || result.status === 'PENDING_REFERENCE') return 202;
  if (result.status === 'REJECTED') return 422;
  if (result.status === 'FAILED') return 503;
  return 200;
}

@Controller()
@UseGuards(ProviderAuthGuard)
class FinanceController {
  constructor(@Inject(FinanceService) private readonly finance: FinanceService) {}

  @Post('wallets')
  createWallet(@Body() body: unknown, @Req() request: CorrelatedRequest) {
    return this.finance.openWallet(parseOpenWallet(body), request.correlationId);
  }

  @Get('wallets/:walletId')
  wallet(@Param('walletId') walletId: string) { return this.finance.getWallet(uuid(walletId, 'walletId')); }

  @Get('wallets/:walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parseLedgerQuery(query);
    return this.finance.getLedger(uuid(walletId, 'walletId'), cursor, limit);
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) { return this.finance.reconcile(uuid(walletId, 'walletId')); }

  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId') transactionId: string) { return this.finance.getTransaction(uuid(transactionId, 'transactionId')); }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  providerTransaction(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.finance.getProviderTransaction(identifier(providerId, 'providerId'), identifier(externalTransactionId, 'externalTransactionId'));
  }

  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: unknown, @Req() request: CorrelatedRequest, @Res({ passthrough: true }) response: Response) {
    const result = await this.finance.submit(parseSubmit(body, key), { correlationId: request.correlationId });
    response.status(transactionHttpStatus(result));
    return result;
  }
}

@Controller()
class HealthController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(SqsBroker) private readonly broker: SqsBroker) {}

  @Get('health/live')
  live() { return { status: 'live' }; }

  @Get('health/ready')
  async ready() {
    try { await Promise.all([this.db.ping(), this.broker.health()]); }
    catch { throw new ApplicationError('NOT_READY', 'Database or message broker is unavailable.', 503); }
    return { status: 'ready' };
  }

  @Get('metrics')
  async renderMetrics(@Res() response: Response): Promise<void> {
    const snapshots = await Promise.allSettled([
      refreshDatabaseMetrics(this.db),
      Promise.resolve().then(() => this.broker.deadLetterDepth()).then(depth => { metrics.set('wager_dlq_messages', depth); }),
    ]);
    snapshots.forEach((snapshot, index) => {
      metrics.set('wager_metrics_dependency_up', snapshot.status === 'fulfilled' ? 1 : 0,
        { dependency: index === 0 ? 'postgresql' : 'sqs' });
    });
    response.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  }
}

export async function createApp(db: Database, finance: FinanceService, broker: SqsBroker, identity: ProviderIdentityPort = new LocalProviderIdentity()): Promise<INestApplication> {
  @Module({
    controllers: [FinanceController, HealthController],
    providers: [
      { provide: Database, useValue: db }, { provide: FinanceService, useValue: finance },
      { provide: SqsBroker, useValue: broker }, { provide: PROVIDER_IDENTITY, useValue: identity }, ProviderAuthGuard,
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  app.use((request: CorrelatedRequest, response: Response, next: NextFunction) => {
    const supplied = request.headers['x-correlation-id'];
    request.correlationId = typeof supplied === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    response.setHeader('X-Correlation-Id', request.correlationId);
    const started = performance.now();
    response.on('finish', () => {
      const durationMs = performance.now() - started;
      // Route templates prevent UUIDs, keys and provider identifiers becoming metric labels.
      const path: string = request.route?.path ?? 'unmatched';
      metrics.increment('wager_http_requests_total', { method: request.method, route: path, status: response.statusCode });
      metrics.observe('wager_http_duration_seconds', durationMs / 1000, { method: request.method, route: path });
      if (path !== '/metrics' && !path.startsWith('/health/')) logger.info('http_request', {
        correlationId: request.correlationId, method: request.method, path, httpStatus: response.statusCode, durationMs,
      });
    });
    next();
  });
  app.use(json({ limit: '64kb', strict: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  await app.init();
  return app;
}
