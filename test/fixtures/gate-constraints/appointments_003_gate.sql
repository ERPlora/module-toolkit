-- Gate/guard table for command-level asserts (the `tables` module gate pattern,
-- adopted via verifactu#27): an assert statement inserts (gate, ok) where ok is 1 only
-- when the guarded invariant holds; ok = 0 violates CHECK (ok = 1) and rolls back the
-- whole command transaction.
-- First consumer: the overlap guard of appointments.appointments.reschedule / .update
-- (appointments#20 — the double-booking invariant must live SERVER-SIDE; `create` is
-- covered by its authoritative `reads` on appointments.appointments.conflicting).
CREATE TABLE IF NOT EXISTS appointments__gate (
    gate TEXT NOT NULL,                 -- gate name (error diagnostics)
    ok   INTEGER NOT NULL CHECK (ok = 1)
);
