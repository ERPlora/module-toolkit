-- Each gate refuses UNDER ITS OWN NAME, so a rolled-back command can say what happened
-- (services#91, the module's share of the pattern inventoried in module-toolkit#92).
--
-- `services__gate` was created (migration 003) with one anonymous column check,
-- `CHECK (ok = 1)`, which Postgres auto-names `services__gate_ok_check`. Every gate that ever
-- fails therefore fails with the SAME message, and the name of the gate that refused travels in
-- the separate DETAIL field of the wire protocol:
--
--     ERROR:   new row for relation "services__gate" violates check constraint "services__gate_ok_check"
--     DETAIL:  Failing row contains (package_redeemable, 0).
--
-- The caller never sees that second line. A refusal reaches the browser through
-- `sqlx::Error::Database` wrapping `PgDatabaseError`, whose `Display` writes the PRIMARY message
-- and nothing else (sqlx-postgres `src/error.rs`), and `message()` does not carry DETAIL. So the
-- three gates of this module — the grant, the redemption and the refund — are indistinguishable
-- to everything downstream: the log, the API, a flow, the assistant.
--
-- This is the module's BACK ROAD, not its front door: since services#52 `services.packages.redeem`
-- answers through the WASM handler's pre-check with a namespaced domain code, and that path does
-- not depend on DETAIL. What is broken is what happens when the pre-check and the gate DISAGREE —
-- a race between the read and the write, or a caller that does not go through the handler: whoever
-- receives the rollback cannot tell WHICH of the three aborted it.
--
-- The fix is to move the gate's identity from the ROW into the CONSTRAINT NAME, which IS part of
-- the primary message. One named constraint per gate, each scoped to its own gate value, so for
-- any given row EXACTLY ONE of them can be violated and the message is deterministic. Postgres
-- does not promise an evaluation order between constraints, and this removes the need for it to.
-- It is also why the anonymous check has to GO rather than stay on as a belt: while both exist,
-- an `ok = 0` row violates both and either name may be the one reported.
--
-- `services__gate_is_declared` is what lets the anonymous check go without opening a hole: with
-- one constraint per gate, a row whose `gate` matches NONE of them would violate nothing, so a
-- typo in an assert would fail OPEN and the command would commit. The whitelist refuses it
-- instead. A new gate must be added to BOTH lists in the same migration, and forgetting fails
-- CLOSED and loudly — the only acceptable direction for a guard table.
--
-- Declared `contract` because of that one DROP. It is an atomic SWAP, not a deferred cleanup: the
-- replacement lands in this same file, so there is no window in which the table is unguarded. The
-- table is empty between commands (`commands/_gate_clear.sql` drains it, and a failed assert rolls
-- its own row back), so validating the new constraints has nothing to scan.

ALTER TABLE services__gate DROP CONSTRAINT IF EXISTS services__gate_ok_check;

ALTER TABLE services__gate ADD CONSTRAINT package_granted
    CHECK (gate <> 'package_granted' OR ok = 1);

ALTER TABLE services__gate ADD CONSTRAINT package_redeemable
    CHECK (gate <> 'package_redeemable' OR ok = 1);

ALTER TABLE services__gate ADD CONSTRAINT redemption_refunded
    CHECK (gate <> 'redemption_refunded' OR ok = 1);

ALTER TABLE services__gate ADD CONSTRAINT services__gate_is_declared
    CHECK (gate IN (
        'package_granted',
        'package_redeemable',
        'redemption_refunded'
    ));
