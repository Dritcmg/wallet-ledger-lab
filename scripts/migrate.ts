import { Database } from '../src/infra/database';
import { config } from '../src/config';

const direction = process.argv[2] ?? 'up';
if (!['up', 'down'].includes(direction)) throw new Error('Usage: bun scripts/migrate.ts up|down [--apply]');
const target = new URL(config.databaseUrl);
if (direction === 'down') {
  const allowed = ['localhost', '127.0.0.1', 'postgres', 'postgres-test'];
  if (!allowed.includes(target.hostname) || !['/wager', '/wager_test'].includes(target.pathname)) {
    throw new Error('Down migrations are restricted to the dedicated local lab databases');
  }
  console.log(JSON.stringify({ action: 'revert_last_migration', host: target.hostname, database: target.pathname.slice(1), destructive: true }));
  if (!process.argv.includes('--apply')) {
    console.log('Preview only. Append --apply to revert the dedicated local schema.');
    process.exit(0);
  }
}
const db = new Database();
try {
  await db.initialize();
  if (direction === 'up') {
    const migrations = await db.dataSource.runMigrations({ transaction: 'all' });
    console.log(JSON.stringify({ action: 'migrate_up', applied: migrations.map(m => m.name) }));
  } else {
    await db.dataSource.undoLastMigration({ transaction: 'all' });
    console.log(JSON.stringify({ action: 'migrate_down', applied: true }));
  }
} finally { await db.close(); }
