-- Guard/gate table for command-level asserts (the `tables` module gate pattern):
-- an assert SQL inserts (gate, ok) where ok is 1 only when the guarded condition holds;
-- ok = 0 violates CHECK (ok = 1) and rolls back the whole command transaction.
-- First consumer: verifactu.contingency.cancel (verifactu#27) — a required record's retry
-- cannot be discarded (VeriFactu FAQ §5: no generated-but-never-remitted orphans).
CREATE TABLE IF NOT EXISTS verifactu__gate (
    gate TEXT NOT NULL,                 -- gate name (error diagnostics)
    ok   INTEGER NOT NULL CHECK (ok = 1)
);
