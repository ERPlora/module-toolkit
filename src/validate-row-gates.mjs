// Publish guard for the affected-rows gates of a command (ERPlora/hub#1091).
//
// A command may declare ONE of two gates over how many rows its `sql` must affect before its
// `emit` events are written: `min_affected_rows` (hub#140, a plain integer, generic error) or
// `expect_rows` (hub#139, the translatable flavour with a namespaced domain code). Both count the
// BATCH, and that is where the hole was: an unconditional statement next to the guarded one — a
// counter UPSERT, an audit INSERT — satisfies the minimum ON BEHALF of the statement that missed,
// so the command answers `200 ok`, nothing is written, and an event goes out for a fact that never
// happened. Measured on `online_booking.bookings.create` (online_booking#25, P0).
//
// `expect_rows.statement` closes it by anchoring the gate to ONE statement. `min_affected_rows`
// cannot: it is an integer, so there is nowhere to name the statement, and the manifest may not
// pair it with `expect_rows`. Over more than one statement it is therefore the neutralizable shape
// with NO cure available, and the runtime refuses it at install.
//
// This is that same refusal one door earlier, where the author still has the manifest open. The
// distance is the whole point of the toolkit: a manifest that passes here and fails there does not
// fail on the author's machine — it fails on a customer's hub, after publishing.
//
// Why it is not `checkManifestKeys`: that walker reads unknown keys, string patterns and closed
// vocabularies. What the canonical schema declares for this is a CONDITIONAL (`if min_affected_rows
// && sql.minItems 2 → then false`), and the walker does not evaluate conditionals — so without this
// file the constraint would be inert here and true only in the hub.
//
// ERROR, not warning, and it breaks nothing: the sweep of the 27 module repos (`origin/main`,
// 25/08/2026) finds ONE `min_affected_rows` in the whole published catalogue —
// `flows.drafts.resolve`, a single statement — which keeps validating untouched.

/** Statements of a command, tolerant of a manifest that declares `sql` as a bare string. */
function statementsOf(command) {
  const sql = command?.sql;
  if (Array.isArray(sql)) return sql;
  if (typeof sql === 'string') return [sql];
  return [];
}

/**
 * Errors in the row gates a manifest declares. Returns a list of formatted strings (empty = clean),
 * the same shape the other `erplora validate` checks use.
 */
export function checkRowGates(manifest) {
  const errors = [];
  const commands = manifest?.commands;
  if (!commands || typeof commands !== 'object') return errors;

  for (const [name, command] of Object.entries(commands)) {
    if (!command || typeof command !== 'object') continue;
    const legacy = command.min_affected_rows !== undefined;
    const expect = command.expect_rows;
    const statements = statementsOf(command);

    // The runtime refuses the pair outright (`installer.rs`): two gates on one command means the
    // author believes one thing is armed and another one runs.
    if (legacy && expect !== undefined) {
      errors.push(
        `commands.${name}: no puede declarar \`min_affected_rows\` y \`expect_rows\` a la vez — ` +
          'son la misma guarda, y el runtime rechaza el manifest que combine las dos. Deja ' +
          '`expect_rows`, que además lleva código de dominio traducible.',
      );
      continue;
    }

    if (legacy && statements.length > 1) {
      errors.push(
        `commands.${name}: \`min_affected_rows\` sobre ${statements.length} sentencias \`sql\`. ` +
          'Esa guarda cuenta el LOTE y no se puede anclar (es un entero: no tiene dónde nombrar la ' +
          'sentencia vigilada), así que una sentencia incondicional hermana satisfaría el mínimo ' +
          'POR la que falló y el command respondería `200 ok` con un evento de algo que no pasó. ' +
          'Declara `expect_rows` con `expect_rows.statement` nombrando la sentencia vigilada. ' +
          'El runtime lo rechaza al INSTALAR, así que un manifest que pase aquí y no allí falla en ' +
          'el hub de un cliente, no en tu máquina.',
      );
    }

    // An anchor that resolves to nothing reads as "protected" while running with the batch-sum
    // default — a guard its author believes armed and is not, which is the exact failure the
    // anchor exists to close. The runtime refuses it too.
    const anchor = expect && typeof expect === 'object' ? expect.statement : undefined;
    if (typeof anchor === 'string' && anchor.length > 0 && !statements.includes(anchor)) {
      errors.push(
        `commands.${name}: \`expect_rows.statement\` ancla en \`${anchor}\`, que no es una de sus ` +
          `sentencias \`sql\` (${JSON.stringify(statements)}). Un ancla que no apunta a nada se ` +
          'leería como protegida sin estarlo, y el runtime lo rechaza al INSTALAR.',
      );
    }
  }
  return errors;
}
