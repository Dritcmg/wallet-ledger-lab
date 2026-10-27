import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuditGuards1730000001000 implements MigrationInterface {
  name = 'AuditGuards1730000001000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION guard_transaction_removal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Financial transaction audit cannot be removed' USING ERRCODE='55000'; END $$;
      CREATE TRIGGER transaction_no_delete BEFORE DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION guard_transaction_removal();
      CREATE TRIGGER transaction_no_truncate BEFORE TRUNCATE ON wager_transactions FOR EACH STATEMENT EXECUTE FUNCTION guard_transaction_removal();

      CREATE FUNCTION check_processed_wallet_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t wager_transactions%ROWTYPE; w wallets%ROWTYPE;
      BEGIN
        SELECT * INTO t FROM wager_transactions WHERE id=NEW.id;
        IF t.status='PROCESSED' THEN
          SELECT * INTO w FROM wallets WHERE id=t.wallet_id;
          IF t.player_id<>w.player_id OR t.currency<>w.currency THEN
            RAISE EXCEPTION 'Processed transaction must match wallet identity' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER transaction_wallet_identity AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_processed_wallet_identity();
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS transaction_wallet_identity ON wager_transactions;
      DROP TRIGGER IF EXISTS transaction_no_delete ON wager_transactions;
      DROP TRIGGER IF EXISTS transaction_no_truncate ON wager_transactions;
      DROP FUNCTION IF EXISTS check_processed_wallet_identity(), guard_transaction_removal();
    `);
  }
}
