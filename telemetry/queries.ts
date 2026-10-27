export const DASHBOARD_UID = "wallet-ledger-lab";
export const DATASOURCE_UID = "wallet-ledger-prometheus";
export const TELEMETRY_QUERIES = {
  "scrape_up": "up{job=\"wallet-ledger-lab\"}",
  "dependencies": "wager_metrics_dependency_up{job=\"wallet-ledger-lab\"}",
  "transactions": "max by (status) (wager_transactions{job=\"wallet-ledger-lab\"})",
  "outbox_pending": "max(wager_outbox_pending_messages{job=\"wallet-ledger-lab\"})",
  "oldest_pending": "max(wager_outbox_oldest_age_seconds{job=\"wallet-ledger-lab\"})",
  "publish_p95": "histogram_quantile(0.95, sum by (le) (wager_outbox_lag_seconds_bucket{job=\"wallet-ledger-lab\"})) or vector(0)",
  "http_p95": "histogram_quantile(0.95, sum by (le) (wager_http_duration_seconds_bucket{job=\"wallet-ledger-lab\",route!~\"/health/.*|/metrics\"})) or vector(0)",
  "responses": "sum by (status) (wager_transaction_responses_total{job=\"wallet-ledger-lab\"})",
  "duplicates": "sum(wager_duplicates_total{job=\"wallet-ledger-lab\"}) or vector(0)",
  "retries": "(sum(wager_retries_total{job=\"wallet-ledger-lab\"}) or vector(0)) + (sum(wager_reference_retries_total{job=\"wallet-ledger-lab\"}) or vector(0))",
  "dlq": "max(wager_dlq_messages{job=\"wallet-ledger-lab\"})",
  "reconciliation": "sum(wager_reconciliation_mismatches_total{job=\"wallet-ledger-lab\"}) or vector(0)"
} as const;
