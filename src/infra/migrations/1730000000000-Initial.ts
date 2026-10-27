import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1730000000000 implements MigrationInterface {
  name = 'Initial1730000000000';
  async up(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(UP_SQL); }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS inbox_messages, outbox_messages, wallet_ledger, wager_transactions, wallets CASCADE;
      DROP FUNCTION IF EXISTS guard_ledger(), guard_wallet(), guard_transaction(), check_wallet_ledger(), check_transaction_ledger();
    `);
  }
}

const UP_SQL = `
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance numeric(38,2) NOT NULL CHECK (balance >= 0),
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(player_id, currency),
  UNIQUE(id, player_id, currency),
  UNIQUE(id, currency)
);
CREATE TABLE wager_transactions (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 128),
  external_transaction_id text NOT NULL CHECK(length(external_transaction_id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  wallet_id uuid NOT NULL,
  player_id uuid NOT NULL,
  round_id text NOT NULL,
  game_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount numeric(38,2) NOT NULL CHECK(amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
  currency varchar(3) NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  reference_external_transaction_id text,
  reference_transaction_id uuid,
  failure_code text,
  result_balance numeric(38,2) CHECK(result_balance >= 0),
  result_currency varchar(3),
  processed_at timestamptz,
  created_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz,
  UNIQUE(provider_id, external_transaction_id),
  UNIQUE(id, wallet_id, currency),
  UNIQUE(id, provider_id, player_id, wallet_id, currency, round_id),
  FOREIGN KEY(wallet_id) REFERENCES wallets(id),
  FOREIGN KEY(reference_transaction_id, provider_id, player_id, wallet_id, currency, round_id)
    REFERENCES wager_transactions(id, provider_id, player_id, wallet_id, currency, round_id),
  CHECK(kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CHECK((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CHECK(status NOT IN ('PROCESSED','REJECTED','FAILED') OR (processed_at IS NOT NULL AND result_balance IS NOT NULL))
);
CREATE UNIQUE INDEX one_reversal_per_kind ON wager_transactions(reference_transaction_id, kind)
  WHERE reference_transaction_id IS NOT NULL AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
CREATE INDEX pending_references_due ON wager_transactions(next_attempt_at, id) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX transactions_wallet ON wager_transactions(wallet_id, created_at, id);
CREATE TABLE wallet_ledger (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL,
  direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
  amount numeric(38,2) NOT NULL CHECK(amount > 0),
  currency varchar(3) NOT NULL,
  balance_before numeric(38,2) NOT NULL CHECK(balance_before >= 0),
  balance_after numeric(38,2) NOT NULL CHECK(balance_after >= 0),
  wallet_version integer NOT NULL CHECK(wallet_version >= 1),
  created_at timestamptz NOT NULL,
  UNIQUE(wallet_id, transaction_id),
  UNIQUE(wallet_id, wallet_version),
  FOREIGN KEY(transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
  FOREIGN KEY(wallet_id, currency) REFERENCES wallets(id, currency),
  CHECK(balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
);
CREATE INDEX ledger_cursor ON wallet_ledger(wallet_id, created_at, id);
CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id text NOT NULL,
  payload_hash text NOT NULL,
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(consumer_name, message_id)
);
CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  locked_until timestamptz,
  claim_token uuid,
  CHECK(payload->>'eventId' = id::text)
);
CREATE INDEX outbox_due ON outbox_messages(next_attempt_at, occurred_at, id) WHERE published_at IS NULL;

CREATE FUNCTION guard_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Ledger is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION guard_ledger();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION guard_ledger();

CREATE FUNCTION guard_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at)
 THEN RAISE EXCEPTION 'Wallet identity immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1)
 OR (NEW.balance = OLD.balance AND NEW.version <> OLD.version)
 THEN RAISE EXCEPTION 'Invalid wallet version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_version BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION guard_wallet();

CREATE FUNCTION guard_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'Terminal transaction immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id,
     NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency, NEW.created_at, NEW.reference_external_transaction_id)
 IS DISTINCT FROM
    (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id,
     OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency, OLD.created_at, OLD.reference_external_transaction_id)
 THEN RAISE EXCEPTION 'Transaction identity immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING'
 THEN RAISE EXCEPTION 'Invalid transaction transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transaction_state BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION guard_transaction();

CREATE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; stored numeric; calculated numeric;
BEGIN
 IF TG_TABLE_NAME = 'wallets' THEN wid := NEW.id; ELSE wid := NEW.wallet_id; END IF;
 SELECT balance INTO stored FROM wallets WHERE id = wid;
 SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) INTO calculated FROM wallet_ledger WHERE wallet_id = wid;
 IF stored IS DISTINCT FROM calculated THEN RAISE EXCEPTION 'Wallet/ledger mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_balanced AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();

CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t wager_transactions%ROWTYPE; n integer; valid integer; ref wager_transactions%ROWTYPE; expected text; tid uuid;
BEGIN
 IF TG_TABLE_NAME = 'wager_transactions' THEN tid := NEW.id; ELSE tid := NEW.transaction_id; END IF;
 SELECT * INTO t FROM wager_transactions WHERE id = tid;
 SELECT count(*) INTO n FROM wallet_ledger WHERE transaction_id = t.id;
 IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN
   IF n <> 1 THEN RAISE EXCEPTION 'Processed monetary transaction requires ledger' USING ERRCODE='23514'; END IF;
   expected := CASE WHEN t.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
   IF t.kind IN ('REFUND','ROLLBACK') OR (t.kind = 'WIN' AND t.reference_transaction_id IS NOT NULL) THEN
     SELECT * INTO ref FROM wager_transactions WHERE id = t.reference_transaction_id;
     IF ref.id IS NULL OR ref.status <> 'PROCESSED' OR
       (t.kind='REFUND' AND ref.kind <> 'BET') OR
       (t.kind='ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND')) OR
       (t.kind='WIN' AND ref.kind <> 'BET') OR
       (t.kind IN ('REFUND','ROLLBACK') AND t.amount <> ref.amount)
     THEN RAISE EXCEPTION 'Invalid processed reference' USING ERRCODE='23514'; END IF;
     IF t.kind='ROLLBACK' THEN SELECT CASE direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END INTO expected FROM wallet_ledger WHERE transaction_id=ref.id; END IF;
   END IF;
   SELECT count(*) INTO valid FROM wallet_ledger WHERE transaction_id=t.id AND wallet_id=t.wallet_id
    AND amount=t.amount AND currency=t.currency AND direction=expected AND balance_after=t.result_balance;
   IF valid<>1 THEN RAISE EXCEPTION 'Ledger must match transaction result' USING ERRCODE='23514'; END IF;
 ELSIF n <> 0 THEN RAISE EXCEPTION 'Non-monetary or unprocessed transaction cannot have ledger' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transaction_ledger AFTER INSERT OR UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
CREATE CONSTRAINT TRIGGER ledger_transaction AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
`;
