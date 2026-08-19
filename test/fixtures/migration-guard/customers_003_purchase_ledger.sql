-- 003_purchase_ledger.sql — customers#8: purchases are a LEDGER, not a blind counter.
--
-- `record_purchase` used to do `total_purchases + 1, total_spent + :total` and forget the sale:
-- a redelivered `sale.completed` (the outbox is at-least-once) counted twice, and a voided sale
-- kept inflating totals and the lifecycle stage forever because nothing remembered which sale had
-- moved them. This table is that memory. One row per commercial link, keyed by
-- `(hub_id, source_type, source_id)`; the aggregates on `customers_customer` are DERIVED from it
-- (moved only when a row is new, reverted when a row is voided) and can be reconciled against it.
--
-- `source_id` is an OPAQUE reference (`sales_sale.id` for `source_type='sale'`): no FK and no
-- JOIN cross-module (§2.5), same as `customers_customer_order.order_id`. History is never
-- deleted: a void flips `status`, it does not remove the row.
CREATE TABLE IF NOT EXISTS customers_purchase_ledger (
    id          TEXT PRIMARY KEY,
    hub_id      TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'sale',     -- sale | manual (a caller without sale_id)
    source_id   TEXT NOT NULL,                    -- opaque: sales_sale.id, or the ledger id itself
    amount      INTEGER NOT NULL DEFAULT 0,       -- cents (ADR-0007), as delivered by the event
    currency    TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | voided
    voided_at   TEXT,
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT, created_by TEXT, updated_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers_customer (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_ledger_source ON customers_purchase_ledger (hub_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS ix_purchase_ledger_customer ON customers_purchase_ledger (hub_id, customer_id, created_at);
