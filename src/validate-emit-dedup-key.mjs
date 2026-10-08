// Publish guard for `commands.*.emit[].dedup_key` (ERPlora/hub#1076, ERPlora/module-toolkit#133).
//
// The vendored schema types `dedup_key` as a string and requires it on the object form of an
// `emit` entry unless the entry anchors with `when_rows` instead (hub#2612), and it stays that way
// on purpose: it is a byte-for-byte copy of the hub's own
// schema (`canonical-mirrors.test.mjs`), so it cannot carry a `minLength` or a `pattern` the hub
// does not declare. `type: string` alone lets an empty string, or a value with no field could ever
// have (spaces, `:`, punctuation), straight through.
//
// `dedup_key` names a field of the command's BOUND payload — the same namespace a `:field` bind in
// its SQL resolves against (`translateForPostgres`, src/validate-prepare.mjs). The runtime degrades
// visibly when it cannot resolve one: it emits WITHOUT deduplicating and reports it with
// `eprintln!` (hub#1331), never rejects the command. That tolerance is right for a value the runtime
// only has access to at RUNTIME (does the field exist on THIS payload, right now) — it is the wrong
// answer for a shape the author could never have made work, which is knowable at PUBLISH time, with
// the manifest still open. Same reasoning `checkRowGates` applies to `expect_rows.statement`.
//
// Why it is not `checkManifestKeys`: that walker reads unknown keys, string patterns declared BY
// THE SCHEMA, and closed vocabularies — and the schema declares no `pattern`/`minLength` for
// `dedup_key` (see above). The walker has nothing to check this against; this file is where the
// constraint the schema cannot express lives instead.

/** The same character set a `:field` bind name accepts (`translateForPostgres`): `\w+`. */
const FIELD_NAME = /^\w+$/;

/**
 * Errors in the `dedup_key` of every object-form `emit` entry. Returns a list of formatted strings
 * (empty = clean), the same shape the other `erplora validate` checks use.
 */
export function checkEmitDedupKey(manifest) {
  const errors = [];
  const commands = manifest?.commands;
  if (!commands || typeof commands !== 'object') return errors;

  for (const [name, command] of Object.entries(commands)) {
    const emit = command?.emit;
    if (!Array.isArray(emit)) continue;

    emit.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) return; // the plain string shape: nothing to check
      // hub#2612: the object form refines with `dedup_key` OR `when_rows` (`anyOf` in the schema). An
      // entry that anchors with `when_rows` and declares no `dedup_key` is whole; `checkEmitWhenRows`
      // judges the anchor. One that declares neither is still a misspelt string, below.
      if (entry.dedup_key === undefined && typeof entry.when_rows === 'string') return;
      const where = `commands.${name}.emit[${i}].dedup_key`;
      const key = entry.dedup_key;

      if (typeof key !== 'string' || key.trim() === '') {
        errors.push(
          `${where}: vacío o ausente — nombra el campo del payload ligado que deriva el id del ` +
            'outbox (ERPlora/hub#1076). Sin un valor, el runtime emite SIN deduplicar y solo lo ' +
            'avisa por log en tiempo de ejecución: aquí, con el manifest abierto, es donde se puede ' +
            'saber que nunca iba a funcionar.',
        );
        return;
      }
      if (!FIELD_NAME.test(key)) {
        errors.push(
          `${where}: \`${key}\` no es un nombre de campo válido — es el mismo espacio que un bind ` +
            '`:campo` en su SQL (solo letras, dígitos y guion bajo), y un valor que no lo respeta ' +
            'nunca resuelve contra el payload.',
        );
      }
    });
  }
  return errors;
}
