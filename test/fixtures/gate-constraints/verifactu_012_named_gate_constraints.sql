-- Each gate refuses UNDER ITS OWN NAME, so a rolled-back command can say what happened
-- (verifactu#40).
--
-- `verifactu__gate` was created (migration 010) with one anonymous column check,
-- `CHECK (ok = 1)`, which Postgres auto-names `verifactu__gate_ok_check`. Every gate that ever
-- fails therefore fails with the SAME message, and the name of the gate that refused travels in
-- the separate DETAIL field of the wire protocol:
--
--     ERROR:   new row for relation "verifactu__gate" violates check constraint "verifactu__gate_ok_check"
--     DETAIL:  Failing row contains (config_save_requires_issuer, 0).
--
-- The caller never sees that second line. A refusal reaches the browser through
-- `sqlx::Error::Database` wrapping `PgDatabaseError`, whose `Display` writes the PRIMARY message
-- and nothing else (sqlx-postgres `src/error.rs`), and `message()` does not carry DETAIL. So the
-- settings screen, which branches on finding `config_save_requires_issuer` in the text, could
-- never find it: a hub with no obligado tributario was told instead that going live is one way
-- (the other gate's message, about a problem it does not have, naming nothing it can fix).
--
-- The fix is to move the gate's identity from the ROW into the CONSTRAINT NAME, which IS part of
-- the primary message. One named constraint per gate, each scoped to its own gate value, so for
-- any given row EXACTLY ONE of them can be violated and the message is deterministic. Postgres
-- does not promise an evaluation order between constraints, and this removes the need for it
-- to. It is also why the anonymous check has to GO rather than stay on as a belt: while both
-- exist, an `ok = 0` row violates both and either name may be the one reported.
--
-- `verifactu__gate_is_declared` is what lets the anonymous check go without opening a hole: an
-- `ok = 0` for a gate nobody declared here is refused by the whitelist instead of slipping
-- through. A new gate must be added to BOTH lists in the same migration, and forgetting fails
-- CLOSED and loudly, which is the only acceptable direction for a guard table.
--
-- Declared `contract` because of that one DROP. It is an atomic SWAP, not a deferred cleanup:
-- the replacement lands in this same file, so there is no window in which the table is
-- unguarded. The table is empty between commands (`_gate_clear.sql` drains it, and a failed
-- assert rolls its own row back), so validating the new constraints has nothing to scan.

ALTER TABLE verifactu__gate DROP CONSTRAINT IF EXISTS verifactu__gate_ok_check;

ALTER TABLE verifactu__gate ADD CONSTRAINT config_save_requires_issuer
    CHECK (gate <> 'config_save_requires_issuer' OR ok = 1);

ALTER TABLE verifactu__gate ADD CONSTRAINT config_save_go_live_is_one_way
    CHECK (gate <> 'config_save_go_live_is_one_way' OR ok = 1);

ALTER TABLE verifactu__gate ADD CONSTRAINT contingency_cancel_requires_accepted_record
    CHECK (gate <> 'contingency_cancel_requires_accepted_record' OR ok = 1);

ALTER TABLE verifactu__gate ADD CONSTRAINT verifactu__gate_is_declared
    CHECK (gate IN (
        'config_save_requires_issuer',
        'config_save_go_live_is_one_way',
        'contingency_cancel_requires_accepted_record'
    ));
