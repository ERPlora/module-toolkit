-- Each gate refuses UNDER ITS OWN NAME, so a rolled-back command can say what happened
-- (tables#76).
--
-- `tables__gate` was created (migration 002) with one anonymous column check,
-- `CHECK (ok = 1)`, which Postgres auto-names `tables__gate_ok_check`. All NINE gates of this
-- module therefore fail with the SAME primary message, and the name of the gate that refused
-- travels in the separate DETAIL field of the wire protocol:
--
--     ERROR:   new row for relation "tables__gate" violates check constraint "tables__gate_ok_check"
--     DETAIL:  Failing row contains (merge_applied, 0).
--
-- The caller never sees that second line. A refusal reaches the browser through
-- `sqlx::Error::Database` wrapping `PgDatabaseError`, whose `Display` writes the PRIMARY message
-- and nothing else (sqlx-postgres `src/error.rs`), and `message()` does not carry DETAIL.
--
-- This is the module's FALLBACK road, not its main one. The WASM handler pre-checks the rows the
-- runtime pre-loads (`reads`, ADR-0069) and answers a domain code before the SQL gate is ever
-- reached (tables#55), so the host normally reads «that table already has an open check» and not
-- a constraint name. What stays broken is what happens when the pre-check and the gate DISAGREE
-- -- a race between two POS on the same table, or any path that does not go through the handler.
-- There, whoever receives the rollback cannot tell which of the nine invariants aborted it:
-- neither the operator, nor the log, nor the assistant.
--
-- The fix is to move the gate's identity from the ROW into the CONSTRAINT NAME, which IS part of
-- the primary message. One named constraint per gate, each scoped to its own gate value, so for
-- any given row EXACTLY ONE of them can be violated and the message is deterministic. Postgres
-- does not promise an evaluation order between constraints, and this removes the need for it to.
-- It is also why the anonymous check has to GO rather than stay on as a belt: while both exist,
-- an `ok = 0` row violates both and either name may be the one reported.
--
-- `tables__gate_is_declared` is what lets the anonymous check go without opening a hole: with one
-- constraint per gate, a row whose `gate` matches none of them violates NOTHING, so a typo in an
-- assert would fail OPEN and the command would commit. The whitelist refuses it instead. A new
-- gate must be added to BOTH lists in the same migration, and forgetting fails CLOSED and loudly,
-- which is the only acceptable direction for a guard table.
--
-- Declared `contract` because of that one DROP. It is an atomic SWAP, not a deferred cleanup: the
-- replacement lands in this same file, so there is no window in which the table is unguarded. The
-- table is empty between commands (`_gate_clear.sql` drains it, and a failed assert rolls its own
-- row back), so validating the new constraints has nothing to scan.
--
-- The nine gates below are the ones `commands/_*_assert.sql` insert. Reference:
-- `verifactu/migrations/postgres/012_named_gate_constraints.sql` (verifactu#40, module-toolkit#92).

ALTER TABLE tables__gate DROP CONSTRAINT IF EXISTS tables__gate_ok_check;

ALTER TABLE tables__gate ADD CONSTRAINT merge_applied
    CHECK (gate <> 'merge_applied' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT session_active
    CHECK (gate <> 'session_active' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT session_not_active
    CHECK (gate <> 'session_not_active' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT split_applied
    CHECK (gate <> 'split_applied' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT table_available
    CHECK (gate <> 'table_available' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT table_without_active_sessions
    CHECK (gate <> 'table_without_active_sessions' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT transfer_applied
    CHECK (gate <> 'transfer_applied' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT zone_exists
    CHECK (gate <> 'zone_exists' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT zone_without_active_tables
    CHECK (gate <> 'zone_without_active_tables' OR ok = 1);

ALTER TABLE tables__gate ADD CONSTRAINT tables__gate_is_declared
    CHECK (gate IN (
        'merge_applied',
        'session_active',
        'session_not_active',
        'split_applied',
        'table_available',
        'table_without_active_sessions',
        'transfer_applied',
        'zone_exists',
        'zone_without_active_tables'
    ));
