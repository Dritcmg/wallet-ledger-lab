import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FinancialGuards1730000002000 implements MigrationInterface {
  name = 'FinancialGuards1730000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wallets ADD CONSTRAINT wallets_balance_finite
        CHECK (balance NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
      ALTER TABLE wager_transactions ADD CONSTRAINT transactions_amount_finite
        CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
      ALTER TABLE wager_transactions ADD CONSTRAINT transactions_result_balance_finite
        CHECK (result_balance NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
      ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_amount_finite
        CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
      ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_balance_before_finite
        CHECK (balance_before NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
      ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_balance_after_finite
        CHECK (balance_after NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

      CREATE OR REPLACE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        wid uuid; stored numeric; stored_version integer; calculated numeric;
        entries bigint; last_version integer; last_balance numeric; continuous boolean;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wid := NEW.id; ELSE wid := NEW.wallet_id; END IF;
        SELECT balance, version INTO stored, stored_version FROM wallets WHERE id = wid;

        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0),
          count(*), max(wallet_version), COALESCE(bool_and(
            CASE WHEN previous_version IS NULL THEN
              balance_before = 0 AND ((wallet_version = 1 AND kind = 'OPENING')
                OR (wallet_version = 2 AND kind <> 'OPENING'))
            ELSE wallet_version = previous_version + 1 AND balance_before = previous_balance AND kind <> 'OPENING'
            END
          ), true)
        INTO calculated, entries, last_version, continuous
        FROM (
          SELECT l.direction, l.amount, l.balance_before, l.wallet_version, t.kind,
            lag(l.balance_after) OVER (ORDER BY l.wallet_version) AS previous_balance,
            lag(l.wallet_version) OVER (ORDER BY l.wallet_version) AS previous_version
          FROM wallet_ledger l JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE l.wallet_id = wid
        ) AS history;

        IF stored IS DISTINCT FROM calculated THEN
          RAISE EXCEPTION 'Wallet/ledger mismatch' USING ERRCODE = '23514';
        END IF;
        IF entries = 0 THEN
          IF stored <> 0 OR stored_version <> 1 THEN
            RAISE EXCEPTION 'An empty ledger requires an unchanged zero wallet' USING ERRCODE = '23514';
          END IF;
        ELSE
          SELECT balance_after INTO last_balance FROM wallet_ledger
            WHERE wallet_id = wid ORDER BY wallet_version DESC LIMIT 1;
          IF NOT continuous OR last_version <> stored_version OR last_balance IS DISTINCT FROM stored THEN
            RAISE EXCEPTION 'Ledger history must match wallet balances and versions' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wid uuid; stored numeric; calculated numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wid := NEW.id; ELSE wid := NEW.wallet_id; END IF;
        SELECT balance INTO stored FROM wallets WHERE id = wid;
        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)
          INTO calculated FROM wallet_ledger WHERE wallet_id = wid;
        IF stored IS DISTINCT FROM calculated THEN
          RAISE EXCEPTION 'Wallet/ledger mismatch' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      ALTER TABLE wallets DROP CONSTRAINT wallets_balance_finite;
      ALTER TABLE wager_transactions DROP CONSTRAINT transactions_amount_finite;
      ALTER TABLE wager_transactions DROP CONSTRAINT transactions_result_balance_finite;
      ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_amount_finite;
      ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_balance_before_finite;
      ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_balance_after_finite;
    `);
  }
}
