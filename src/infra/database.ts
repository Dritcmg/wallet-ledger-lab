import 'reflect-metadata';
import { DataSource, type EntityManager } from 'typeorm';
import { config } from '../config';
import { WalletEntity, TransactionEntity, LedgerEntity } from './entities';
import { Initial1730000000000 } from './migrations/1730000000000-Initial';
import { AuditGuards1730000001000 } from './migrations/1730000001000-AuditGuards';
import { FinancialGuards1730000002000 } from './migrations/1730000002000-FinancialGuards';

export class Database {
  readonly dataSource: DataSource;
  constructor(url: string = config.databaseUrl) {
    this.dataSource = new DataSource({
      type: 'postgres', url, entities: [WalletEntity, TransactionEntity, LedgerEntity],
      migrations: [Initial1730000000000, AuditGuards1730000001000, FinancialGuards1730000002000], synchronize: false, logging: false,
      connectTimeoutMS: 5000,
      extra: { max: 20, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 },
    });
  }
  async initialize(): Promise<void> { if (!this.dataSource.isInitialized) await this.dataSource.initialize(); }
  async close(): Promise<void> { if (this.dataSource.isInitialized) await this.dataSource.destroy(); }
  async ping(): Promise<void> { await this.dataSource.query('SELECT 1'); }
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction('READ COMMITTED', async manager => {
      await manager.query("SET LOCAL lock_timeout = '5s'");
      return fn(manager);
    });
  }
}
