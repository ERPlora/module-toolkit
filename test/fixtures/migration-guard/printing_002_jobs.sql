-- Printing · print job requests (printing#18).
--
-- The module's own ledger of what it ASKED the hub to print through `printing.jobs.create`. The
-- queue itself is the runtime's `_print_queue` (ADR-0196 §6, a system table this module cannot
-- read); this table is the module-side record — who requested which document, when — keyed by
-- the same `job_id` the queue dedups on. Same portable subset as 001 (ADR-0007): TEXT ids, TEXT
-- ISO-8601 dates, INTEGER 0/1 flags. Row contract §2.5: hub_id + soft-delete + audit.
CREATE TABLE IF NOT EXISTS printing_jobs (
    id            TEXT PRIMARY KEY,
    hub_id        TEXT NOT NULL,
    job_id        TEXT NOT NULL,              -- idempotency key chosen by the caller (= _print_queue.job_id)
    document_type TEXT NOT NULL,              -- closed vocabulary of the queue (print_queue::DOCUMENT_TYPES)
    role          TEXT,                       -- optional station override (hub#987: absent = the hub decides)
    format        TEXT,                       -- optional paper format (absent = receipt)
    is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    created_by TEXT, updated_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_printing_jobs_job ON printing_jobs (hub_id, job_id);
