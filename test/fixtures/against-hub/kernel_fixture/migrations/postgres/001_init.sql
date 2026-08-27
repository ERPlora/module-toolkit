CREATE TABLE IF NOT EXISTS kernel_fixture_item (
  id TEXT PRIMARY KEY,
  hub_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  deleted_at TEXT
);
