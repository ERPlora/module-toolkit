// Publish guard for `commands.*.emit[].when_rows` (ERPlora/hub#2612, ERPlora/module-toolkit#464).
//
// `when_rows` anchors an event to ONE of the command's own `sql` statements: the hub writes the
// outbox row only when THAT statement affected at least one row, decided inside the same
// transaction, and a pass that changed nothing still answers `ok` with its other effects committed
// — the shape a scheduled sweep needs (most passes find nothing to do), which `min_affected_rows`
// and `expect_rows` cannot give (both roll back and hand the caller an error).
//
// The vendored schema types it as a non-empty string and that is all it can say. Two things are
// knowable only by reading the whole command, and the hub's installer (`installer.rs`,
// `validate_command_contracts`) refuses both at INSTALL:
//
//   * an anchor that names NONE of the command's `sql` entries — it would read as "announces only
//     on change" while the runtime could not honour it;
//   * `when_rows` on a command resolved by a `handler` — the handler does not run the `sql` list as
//     written, so there is no statement count to anchor to (the handler returns the event instead).
//
// This is that refusal one door earlier, with the manifest still open. Same reasoning
// `checkRowGates` applies to `expect_rows.statement`, and not `checkManifestKeys` for the same
// reason: the walker reads keys, patterns and vocabularies, never one field against another.

/** Statements of a command, tolerant of a manifest that declares `sql` as a bare string. */
function statementsOf(command) {
  const sql = command?.sql;
  if (Array.isArray(sql)) return sql;
  if (typeof sql === 'string') return [sql];
  return [];
}

/**
 * Errors in the `when_rows` of every object-form `emit` entry. Returns a list of formatted strings
 * (empty = clean), the same shape the other `erplora validate` checks use.
 */
export function checkEmitWhenRows(manifest) {
  const errors = [];
  const commands = manifest?.commands;
  if (!commands || typeof commands !== 'object') return errors;

  for (const [name, command] of Object.entries(commands)) {
    const emit = command?.emit;
    if (!Array.isArray(emit)) continue;
    const statements = statementsOf(command);

    emit.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) return; // the plain string shape
      if (entry.when_rows === undefined) return; // a dedup_key-only object: nothing to anchor
      const where = `commands.${name}.emit[${i}].when_rows`;
      const anchor = entry.when_rows;

      if (command.handler !== undefined && command.handler !== null) {
        errors.push(
          `${where}: the command is resolved by a handler, whose statements are not the ones it ` +
            'declares in `sql`, so there is no statement to anchor the event to. Return the event ' +
            'from the handler instead (one per changed row, if you like). The hub refuses this at ' +
            'INSTALL (ERPlora/hub#2612).',
        );
        return;
      }
      if (typeof anchor !== 'string' || !statements.includes(anchor)) {
        errors.push(
          `${where}: anchors \`${String(anchor)}\`, which is not one of the command's \`sql\` ` +
            `entries (${JSON.stringify(statements)}). An anchor that names no statement would read ` +
            'as "announces only on change" while the runtime could not honour it; the hub refuses ' +
            'it at INSTALL (ERPlora/hub#2612).',
        );
      }
    });
  }
  return errors;
}
