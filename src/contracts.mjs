// Contratos de interoperabilidad (ADR-0127): extractor AST + contracts.json + validación cruzada.
//
// El contrato EFECTIVO de un módulo (qué consume de otros) vive en su código como strings
// literales sobre el SDK. Esto lo extrae por AST — SOLO de llamadas reconocidas al SDK, nunca
// barriendo strings (un literal con forma `modulo.algo` puede vivir en un mensaje de error o en
// código muerto: contarlo haría el validador frágil y ruidoso, y un validador ruidoso se ignora).
//
// La regla dura: **identificador literal o error**. `query(variable)` es un contrato dinámico y
// falla el build — no se siguen variables ni constantes (el patrón helper se refactoriza a thunk:
// `this.run(() => erplora().command('x.y', p))`, que deja el literal EN la llamada al SDK).
// Escape explícito y visible en el diff: `// erplora-contracts: ignore` en la línea anterior o en
// la misma línea.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import ts from 'typescript';

// ── Reconocedores declarativos ────────────────────────────────────────────────────────────────
// Un reconocedor = nombre de la función/método del SDK + en qué argumento viaja el contrato +
// de qué clase es. Añadir un método nuevo al SDK = una línea aquí (y su test), no un caso especial.
export const RECOGNIZERS = {
  query: { kind: 'query', argument: 0, required: true },
  queryAll: { kind: 'query', argument: 0, required: true },
  queryPage: { kind: 'query', argument: 0, required: true },
  queryOptional: { kind: 'query', argument: 0, required: false },
  // sales#186: `queryAll` plus `queryOptional`'s tolerance — the WHOLE set of a module that may not
  // be installed. Optional like its sibling: no `depends_on`, but the name must exist if the owner
  // is in the universe.
  queryAllOptional: { kind: 'query', argument: 0, required: false },
  command: { kind: 'command', argument: 0, required: true },
  // hub#1428 (ADR-0438): the same OPTIONAL door as `queryOptional`, but for WRITING — a module
  // with `depends_on: []` inserting a row into a module that may not be installed. Optional
  // like its reading sibling: no `depends_on`, but the name must exist if the owner is known.
  commandOptional: { kind: 'command', argument: 0, required: false },
  on: { kind: 'event', argument: 0 },
  loadSlot: { kind: 'slot', argument: 0 },
  createListController: { kind: 'query', argument: 1, required: true },
};

/** Nombre con namespace: `modulo.operacion[...]`. El primer segmento identifica al dueño. */
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/**
 * Las claves de `consumes`, en el orden en que se serializan: cada superficie obligatoria seguida
 * de su hermana opcional.
 */
const CONSUMES_KEYS = ['queries', 'optional_queries', 'commands', 'optional_commands', 'events', 'slots'];

/**
 * Claves que se OMITEN cuando están vacías, en vez de emitirse como `[]`.
 *
 * `.erplora/contracts.json` se commitea y `erplora validate` lo compara byte a byte con el
 * generado: emitir `optional_commands: []` en todos los módulos habría dejado obsoletos de golpe
 * los 36 artefactos ya commiteados del workspace — y como el gate de cada módulo corre
 * `module-gate.yml@main`, los 27 repos se habrían puesto en rojo el día del merge sin haber
 * cambiado ni una línea. La clave aparece cuando hay algo que poner en ella, que es justo cuando
 * el módulo regenera su artefacto de todas formas.
 */
const OMIT_WHEN_EMPTY = new Set(['optional_commands']);

/** En qué lista de `consumes` cae un reconocedor: la superficie, partida por obligatorio/opcional. */
function bucketFor({ kind, required }) {
  if (kind === 'query') return required === false ? 'optional_queries' : 'queries';
  if (kind === 'command') return required === false ? 'optional_commands' : 'commands';
  return kind === 'event' ? 'events' : 'slots';
}

const IGNORE_MARK = 'erplora-contracts: ignore';

// ── Extracción ────────────────────────────────────────────────────────────────────────────────

/** Ficheros TS de la UI del módulo (fuente, no dist; los .test.ts mockean nombres a propósito). */
function uiSourceFiles(dir) {
  const root = join(dir, 'ui');
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(abs);
    }
  };
  walk(root);
  return out;
}

/** ¿La línea del nodo (o la anterior) lleva el escape explícito? */
function lineIsIgnored(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const lines = source.text.split('\n');
  const current = lines[line] ?? '';
  const previous = lines[line - 1] ?? '';
  return current.includes(IGNORE_MARK) || previous.includes(IGNORE_MARK);
}

/**
 * Extrae la superficie consumida de `ui/**∕*.ts`.
 * Devuelve `{ consumes, violations, refs }`:
 *   - consumes: listas ordenadas y sin duplicados (lo que persiste en contracts.json)
 *   - violations: contratos dinámicos (literal ausente) con fichero:línea → error de build
 *   - refs: cada referencia con su ubicación (solo para MENSAJES de error del validador;
 *     jamás se persiste — líneas en el contrato = diffs irrelevantes al mover código)
 */
export function extractContracts(dir, manifest) {
  const sets = Object.fromEntries(CONSUMES_KEYS.map((k) => [k, new Set()]));
  const violations = [];
  const refs = [];

  for (const file of uiSourceFiles(dir)) {
    const rel = relative(dir, file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    // Alias de imports con nombre del SDK: `import { createListController as mkCtrl } from
    // '@erplora/module-sdk'` → `mkCtrl` reconoce como `createListController`.
    const aliases = new Map();
    for (const stmt of source.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const from = stmt.moduleSpecifier.getText(source).slice(1, -1);
      if (!from.includes('@erplora/module-sdk')) continue;
      const named = stmt.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const original = (el.propertyName ?? el.name).text;
          if (RECOGNIZERS[original]) aliases.set(el.name.text, original);
        }
      }
    }

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        // Método sobre el cliente (`c.query(...)`, `erplora().command(...)`) o función libre
        // importada del SDK (con o sin alias). El receptor NO se resuelve a propósito: seguir
        // variables es el camino al validador frágil; el nombre del método + el literal bastan.
        let recognized;
        if (ts.isPropertyAccessExpression(node.expression)) {
          recognized = RECOGNIZERS[node.expression.name.text];
        } else if (ts.isIdentifier(node.expression)) {
          const original = aliases.get(node.expression.text) ?? node.expression.text;
          if (aliases.has(node.expression.text) || RECOGNIZERS[node.expression.text]) {
            recognized = RECOGNIZERS[original];
          }
        }

        if (recognized) {
          const arg = node.arguments[recognized.argument];
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
            const name = arg.text;
            if (NAME_RE.test(name)) {
              sets[bucketFor(recognized)].add(name);
              refs.push({ kind: recognized.kind, required: recognized.required !== false, name, file: rel, line: line + 1 });
            }
            // Un literal SIN namespace en on()/loadSlot() no es un contrato de dominio (p.ej. un
            // evento DOM): se ignora. En query/command todo nombre real lleva namespace.
          } else if (arg && !lineIsIgnored(source, node)) {
            violations.push({
              file: rel,
              line: line + 1,
              message:
                `contrato dinámico: \`${node.expression.getText(source)}(…)\` sin literal — ` +
                `el nombre debe ser un string literal en la llamada al SDK (regla ADR-0127; ` +
                `patrón thunk para helpers, o \`// ${IGNORE_MARK}\` si es un falso positivo)`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const consumes = {};
  for (const k of CONSUMES_KEYS) {
    if (sets[k].size === 0 && OMIT_WHEN_EMPTY.has(k)) continue;
    consumes[k] = [...sets[k]].sort();
  }
  return { consumes, violations, refs };
}

// ── contracts.json ────────────────────────────────────────────────────────────────────────────

/** El contrato efectivo consumido: mínimo, ordenado, determinista. Sin líneas ni timestamps. */
export function buildContracts(dir, manifest) {
  const { consumes } = extractContracts(dir, manifest);
  return { schema_version: 1, module: manifest.id, consumes };
}

const CONTRACTS_REL = join('.erplora', 'contracts.json');

export function contractsPath(dir) {
  return join(dir, CONTRACTS_REL);
}

function serialize(contracts) {
  return JSON.stringify(contracts, null, 2) + '\n';
}

export function writeContractsFile(dir, manifest) {
  const contracts = buildContracts(dir, manifest);
  mkdirSync(join(dir, '.erplora'), { recursive: true });
  writeFileSync(contractsPath(dir), serialize(contracts));
  return contracts;
}

/** ¿El contracts.json commiteado difiere del que generaría el código actual? */
export function contractsFileIsStale(dir, manifest) {
  const path = contractsPath(dir);
  if (!existsSync(path)) return true;
  return readFileSync(path, 'utf8') !== serialize(buildContracts(dir, manifest));
}

// ── Universo y validación cruzada ─────────────────────────────────────────────────────────────

/**
 * Nombre de un entry de `commands[].emit`, en cualquiera de sus dos formas (ERPlora/hub#1076,
 * ERPlora/module-toolkit#133): el string plano de siempre, o el objeto `{event, dedup_key}` que
 * añade una clave de deduplicación en el outbox. El universo de eventos cuenta por NOMBRE en las
 * dos formas — mirar solo la primera dejaría de ver como emisor a cualquier módulo que adopte
 * `dedup_key`, exactamente el hueco que `events.emits` (arriba) ya cerró para el handler WASM.
 */
function emitName(entry) {
  return typeof entry === 'string' ? entry : entry?.event;
}

/**
 * What a manifest OFFERS to the rest of the workspace. This is the projection that goes into the
 * universe, and the same one `checkContracts` seeds with the module's own manifest: computed
 * separately the two could drift, and then validating alone and validating with neighbours would
 * say different things.
 */
function ownSurface(m) {
  // A module declares what it emits through TWO channels, and both count (module-toolkit#35):
  // `commands[].emit` is what the declarative dispatcher emits, and `events.emits` is the FULL
  // catalogue — the one that also carries what WASM handlers return, which comes from no command.
  // Looking only at the former, the validator deferred as «nobody declares it» the 32 events that
  // after hub#709 live only in the latter (`sale.completed`, `order.fired`, the 9 of `kitchen`):
  // precisely the ones at the centre of the hub.
  const emits = new Set(Array.isArray(m.events?.emits) ? m.events.emits : []);
  for (const cmd of Object.values(m.commands ?? {})) for (const e of cmd.emit ?? []) emits.add(emitName(e));
  return {
    queries: new Set(Object.keys(m.queries ?? {})),
    commands: new Set(Object.keys(m.commands ?? {})),
    emits,
  };
}

/**
 * Is `dir` a git WORKTREE rather than a real checkout? A worktree carries `.git` as a FILE (a
 * `gitdir:` pointer); a regular clone carries it as a DIRECTORY. It is the same discriminator the
 * root CLAUDE.md uses to count the real modules inside `modules-workspace`.
 */
function isGitWorktree(dir) {
  try {
    return statSync(join(dir, '.git')).isFile();
  } catch {
    return false; // no `.git` at all (a loose copy, a `git archive`) is not a worktree
  }
}

/**
 * Of all the directories declaring the SAME id, which one is the real module? Lowest wins:
 *   0. the directory is named after the id — the canonical checkout is always `modules/<id>/`;
 *   1. it is not a worktree — a worktree is ONE worker's in-flight branch, not the reference;
 *   2. …and on a tie, alphabetical order: any criterion is fine as long as it is DETERMINISTIC.
 * What we had before was «the last entry `readdirSync` returns wins», which is not a criterion.
 */
function neighbourRank(dirName, dir, id) {
  return [dirName === id ? 0 : 1, isGitWorktree(dir) ? 1 : 0, dirName];
}

/**
 * The workspace universe: what every module offers (read from the neighbouring module.json files).
 * In the marketplace/install-plan the SAME validator receives another universe — the set changes,
 * not the engine.
 *
 * Also returns `shadowed`: the directories with a DUPLICATE id that were discarded. The fleet
 * creates worktrees inside `modules-workspace/modules/` (`appointments-wt-89`, `verifactu-wt-1559`),
 * so two directories with the same id is the tree's NORMAL state, not an edge case — and until
 * module-toolkit#176/#199 the last one out of `readdirSync` silently replaced the real module, in
 * both directions: a false red (the sound neighbour «lacks» the query) and a false green (the
 * sibling declares the name you just misspelt). Choosing without saying so would repeat the
 * expensive half of the bug: whoever looks at the tree must be able to see what they were
 * validated against.
 */
export function loadUniverseFull(modulesDir) {
  const universe = new Map();
  const shadowed = [];
  if (!existsSync(modulesDir)) return { universe, shadowed };
  const byId = new Map();
  for (const name of readdirSync(modulesDir)) {
    const manifestPath = join(modulesDir, name, 'module.json');
    if (!existsSync(manifestPath)) continue;
    let m;
    try {
      m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue; // un manifest ilegible no tumba la validación de los demás
    }
    if (typeof m?.id !== 'string' || !m.id) continue;
    if (!byId.has(m.id)) byId.set(m.id, []);
    byId.get(m.id).push({ name, manifest: m });
  }

  for (const [id, candidates] of byId) {
    candidates.sort((a, b) => {
      const ra = neighbourRank(a.name, join(modulesDir, a.name), id);
      const rb = neighbourRank(b.name, join(modulesDir, b.name), id);
      return ra[0] - rb[0] || ra[1] - rb[1] || String(ra[2]).localeCompare(String(rb[2]));
    });
    const [winner, ...ignored] = candidates;
    if (ignored.length) shadowed.push({ id, chosen: winner.name, ignored: ignored.map((c) => c.name) });
    universe.set(id, ownSurface(winner.manifest));
  }
  return { universe, shadowed };
}

/** Simple form: just the universe (most callers do not need the duplicate ids). */
export function loadUniverse(modulesDir) {
  return loadUniverseFull(modulesDir).universe;
}

/**
 * Cruza el contrato consumido + el manifest contra el universo. Devuelve `{ errors, deferred }`:
 *   - errors: contratos rotos → el build FALLA (error, nunca warning: un warning es el mismo
 *     silencio que este contrato mata)
 *   - deferred: dependencias declaradas que no están en el universo (CI por-módulo sin el
 *     workspace al lado) → constancia de lo no comprobado; lo cubren la publicación/instalación
 */
/**
 * Namespace RESERVADO del core en el dispatcher (ADR-0192): lo sirve el runtime, no un módulo.
 * Un módulo lo consume como cualquier otra query (`erplora().query('hub.users.list')`) pero NO lo
 * declara en `depends_on`: no es instalable ni participa del topo-orden.
 *
 * La lista es el espejo de `CORE_QUERIES` en `hub/crates/runtime/src/hub_users.rs`. Si el runtime
 * gana una capacidad de core nueva, se añade aquí — si no, el gate la rechaza como typo.
 *
 * ⚠️ **Copiada a mano, y ya se había desincronizado** (hub#297): `setup.status` y `approvals.list`
 * llevaban semanas vivas en el runtime mientras este gate las seguía llamando typo. Es la dirección
 * cara de la deriva — al módulo que consume una query real del core se le dice que no existe—, y
 * quien añade la query en Rust no tiene forma de enterarse de que hay un segundo sitio. Desde
 * hub#297 hay alarma: `test/canonical-mirrors.test.mjs` lee `CORE_QUERIES` del checkout del hub y
 * exige que esta lista sea exactamente esa (se salta sola cuando el hub no está al lado, que es el
 * caso del runner del gate).
 */
const CORE_NAMESPACE = 'hub';
export const CORE_OPERATIONS = {
  queries: [
    'hub.users.list',
    'hub.roles.list',
    'hub.setup.status',
    'hub.approvals.list',
    // hub#297 — the simplified-invoice ceiling as DATA: the core ANSWERS, the POS DECIDES.
    'hub.fiscal.limits',
    // hub#1453 — the ROUTE the hub transmits to the AEAT through (delegated or own certificate)
    // is DATA a module reads: the core resolves it, the POS decides what to show.
    'hub.fiscal.transmission',
    // hub#1107 — the print queue is READABLE by a module: coverage per station and the queue
    // as a status view (the document never travels; it leaves through the drain, ADR-0192).
    'hub.print.coverage',
    'hub.print.jobs',
  ],
  commands: [],
};

/** Ids de un `depends_on` en cualquiera de sus dos formas (string u objeto `{ id, min_version }`). */
export function dependencyIds(declared) {
  const out = [];
  for (const d of declared ?? []) {
    if (typeof d === 'string' && d.trim()) out.push(d.trim());
    else if (d && typeof d === 'object' && typeof d.id === 'string' && d.id.trim()) out.push(d.id.trim());
  }
  return out;
}

export function crossValidateFull(manifest, contracts, universe) {
  const errors = [];
  const deferred = [];
  const me = manifest.id;
  // hub#681: `depends_on` admite string plano u objeto `{ id, min_version }` (suelo de versión).
  // El contrato de interoperabilidad va por ID; el suelo lo valida el instalador del hub.
  const deps = new Set(dependencyIds(manifest.depends_on));
  const missingDeps = new Set([...deps].filter((d) => !universe.has(d)));
  for (const d of missingDeps) deferred.push(`depends_on \`${d}\` no está en el workspace: su contrato se comprobará en la publicación/instalación`);

  const allEmits = new Set();
  for (const mod of universe.values()) for (const e of mod.emits) allEmits.add(e);

  const checkOperation = (name, opKind, { optional = false } = {}) => {
    const owner = name.split('.')[0];
    const surface = opKind === 'command' ? 'commands' : 'queries';
    // El consejo tiene que nombrar el helper de SU superficie: mandar a `queryOptional` a quien
    // está ESCRIBIENDO es un mensaje que no se puede seguir (hub#1428, ADR-0438).
    const optionalHelper = opKind === 'command' ? 'commandOptional' : 'queryOptional';
    // El CORE no es un módulo (ADR-0192): `hub.` es su namespace reservado en el dispatcher. No se
    // declara en `depends_on` (no hay nada que instalar ni que ordenar topológicamente) y siempre
    // está presente. Pero el nombre sí se comprueba: un typo aquí también es un contrato roto.
    if (owner === CORE_NAMESPACE) {
      if (!CORE_OPERATIONS[surface].includes(name)) {
        errors.push(`\`${name}\`: no existe en el core (capacidades del namespace \`${CORE_NAMESPACE}.\`: ${CORE_OPERATIONS[surface].join(', ') || 'ninguna'})`);
      }
      return;
    }
    if (owner === me) {
      if (!universe.get(me)?.[surface].has(name)) {
        errors.push(`\`${name}\`: no existe en el propio manifest de \`${me}\` (¿typo?)`);
      }
      return;
    }
    if (!universe.has(owner)) {
      // Dueño desconocido: para lo OBLIGATORIO con dep declarada ya quedó aplazado arriba; para
      // queryOptional/commandOptional a un módulo fuera del universo, se resuelve en la instalación.
      if (!optional && !missingDeps.has(owner) && !deps.has(owner)) {
        errors.push(`\`${name}\`: llamada a \`${owner}\` que no está en depends_on de \`${me}\``);
      }
      return;
    }
    if (!optional && !deps.has(owner)) {
      errors.push(`\`${name}\`: llamada a \`${owner}\` que no está en depends_on de \`${me}\` (si la integración es opcional, usa ${optionalHelper})`);
    }
    if (!universe.get(owner)[surface].has(name)) {
      errors.push(`\`${name}\`: no existe en el manifest de \`${owner}\`${optional ? ` (${optionalHelper} permite AUSENCIA del módulo, no contratos rotos)` : ''}`);
    }
  };

  for (const q of contracts.consumes.queries) checkOperation(q, 'query');
  for (const q of contracts.consumes.optional_queries) checkOperation(q, 'query', { optional: true });
  for (const c of contracts.consumes.commands) checkOperation(c, 'command');
  // `optional_commands` se omite del artefacto cuando está vacía (ver OMIT_WHEN_EMPTY), y este
  // validador también recibe contratos LEÍDOS del marketplace, generados por toolkits anteriores.
  for (const c of contracts.consumes.optional_commands ?? []) checkOperation(c, 'command', { optional: true });

  // reads (ADR-0069): declarados en el manifest — el handler corre en un sandbox y solo verá lo
  // que estas queries devuelvan; una read con typo se omitía EN SILENCIO en runtime.
  for (const [cmdName, cmd] of Object.entries(manifest.commands ?? {})) {
    for (const read of cmd.reads ?? []) {
      // El runtime acepta DOS formas (manifest.rs, `ReadDef` untagged): "q.name" y
      // { query, params } — la parametrizada filtra por campos del payload.
      const name = typeof read === 'string' ? read : read?.query;
      if (typeof name !== 'string' || !name) {
        errors.push(`reads de \`${cmdName}\`: entrada malformada (se espera "query" o { query, params }): ${JSON.stringify(read)}`);
        continue;
      }
      const owner = name.split('.')[0];
      if (missingDeps.has(owner)) continue; // aplazado
      const surface = owner === me ? universe.get(me) : universe.get(owner);
      // Un read con `required: false` es la forma DOCUMENTADA de decir «este módulo puede no estar
      // instalado». Si su dueño no está en el universo no hay contrato que comprobar todavía: se
      // APLAZA a la instalación, exactamente como `checkOperation` hace con `queryOptional`.
      //
      // Sin esta rama, el gate tumbaba una integración opcional legítima por un motivo que solo se
      // da en CI: en local el módulo vecino está en el disco y el universo lo ve, pero el workflow
      // hace checkout de UN módulo, así que el universo tiene un elemento y el dueño nunca aparece.
      // Mordió con el primer `required: false` del repo (pm#93, `modifiers.options.all`).
      //
      // El límite se mantiene: si el dueño SÍ está en el universo, un nombre inventado sigue siendo
      // un contrato roto. Opcional es la AUSENCIA del módulo, no el typo.
      const optionalRead = typeof read === 'object' && read?.required === false;
      if (!surface) {
        if (optionalRead && owner !== me) {
          deferred.push(
            `reads de \`${cmdName}\`: \`${name}\` es opcional y \`${owner}\` no está en el workspace: su contrato se comprobará en la publicación/instalación`,
          );
          continue;
        }
        // The owner is not in the universe. Saying «the query does not exist» points at the wrong
        // module and reads EXACTLY like a typo, so it cannot tell a broken module from a module
        // validated alone (module-toolkit#199). The real fault is that nobody declared the
        // dependency — the same one `checkOperation` already names properly for queries and commands.
        if (owner !== me && !deps.has(owner)) {
          errors.push(`reads de \`${cmdName}\`: \`${name}\` llama a \`${owner}\`, que no está en depends_on de \`${me}\``);
          continue;
        }
        errors.push(`reads de \`${cmdName}\`: la query \`${name}\` no existe`);
        continue;
      }
      if (!surface.queries.has(name)) {
        errors.push(`reads de \`${cmdName}\`: la query \`${name}\` no existe en \`${owner}\``);
      }
    }
  }

  // Eventos: hoy muchos se emiten DINÁMICAMENTE desde el handler WASM (`sale.completed`,
  // `kitchen.order.fired`) y no son declarables sin doble emisión (el runtime emite lo declarado
  // ADEMÁS de lo del handler, y aún no hay dedup — fase 2). Hasta que la fase 3 haga obligatoria
  // la declaración de emisiones, un evento que nadie declara se APLAZA con constancia, no error:
  // un validador que error-ea en falso se ignora, y eso mata el contrato entero. (Que el emisor no
  // esté instalado en un hub concreto tampoco es error: lo decide la instalación, severidad info.)
  // Un evento del CORE no sale de ningún manifest (module-toolkit#37): `hub.` es el namespace
  // reservado del runtime (ADR-0192), que lo escribe él mismo en `_event_outbox` —
  // `hub.whatsapp.message_received` nace en `crates/server/src/inbound_poll.rs`. Resolverlo
  // contra lo que emiten los módulos del workspace es preguntarle a la fuente equivocada, y el
  // aviso resultante («typo o emisión dinámica») describía como error el patrón RECOMENDADO para
  // reaccionar a lo que entra por WhatsApp (hub#659). Peor: la fase 3 de ADR-0127 lo volvería un
  // error y el gate rechazaría a esos módulos.
  //
  // Se reconoce el NAMESPACE, no una lista de nombres: el core no publica hoy ningún registro de
  // eventos (a diferencia de sus queries, que sí están en `CORE_QUERIES`), así que una lista aquí
  // sería un cuarto espejo sin fuente que lo respalde. El día que el hub sirva ese registro —como
  // hizo con `flow.schema.json` en hub#716— este es el sitio donde se lee y el nombre pasa a
  // comprobarse de verdad.
  const eventKnown = (ev) => allEmits.has(ev) || ev.split('.')[0] === CORE_NAMESPACE;
  for (const ev of contracts.consumes.events) {
    if (!eventKnown(ev)) deferred.push(`evento \`${ev}\`: nadie del workspace lo DECLARA (emisión dinámica de handler o typo — la fase 3/ADR-0127 lo vuelve error)`);
  }
  for (const ev of Object.keys(manifest.events?.listen ?? {})) {
    if (!eventKnown(ev)) deferred.push(`listen \`${ev}\`: nadie del workspace lo DECLARA (emisión dinámica de handler o typo — la fase 3/ADR-0127 lo vuelve error)`);
  }

  // Slots: el HOST define sus puntos de extensión → loadSlot lleva el prefijo del propio módulo.
  for (const slot of contracts.consumes.slots) {
    if (slot.split('.')[0] !== me) {
      errors.push(`loadSlot \`${slot}\`: un host solo carga SUS puntos de extensión (prefijo \`${me}.\`)`);
    }
  }

  return { errors, deferred };
}

/** Versión simple: solo los errores (la mayoría de llamadores no necesita los aplazados). */
export function crossValidate(manifest, contracts, universe) {
  return crossValidateFull(manifest, contracts, universe).errors;
}

// ── Integración con `erplora validate` ────────────────────────────────────────────────────────

/**
 * El chequeo completo que corre `erplora validate`: extracción (violaciones dinámicas) +
 * frescura de contracts.json + validación cruzada contra el workspace (los vecinos de `dir`).
 * Todo son ERRORES — un warning que nadie lee es el mismo silencio que este contrato mata.
 */
export function checkContracts(dir, manifest) {
  const errors = [];

  const { violations } = extractContracts(dir, manifest);
  for (const v of violations) errors.push(`${v.file}:${v.line}: ${v.message}`);

  if (contractsFileIsStale(dir, manifest)) {
    errors.push(`.erplora/contracts.json desactualizado o ausente — corre \`erplora contracts ${manifest.id}\` y commitea el resultado`);
  }

  const { universe, shadowed } = loadUniverseFull(join(dir, '..'));

  // The module under validation is the ONLY one whose manifest is known for certain — we just read
  // it from `dir` — and it was precisely the one being ignored: `loadUniverse` rediscovered it from
  // the tree, and any sibling directory with the same `id` (a fleet worktree) replaced it
  // (module-toolkit#176). Seeding it here closes that regardless of what sits around, and hides
  // nothing: the seed is the real manifest, so a typo against yourself stays red.
  universe.set(manifest.id, ownSurface(manifest));

  const contracts = buildContracts(dir, manifest);
  const { errors: crossErrors, deferred } = crossValidateFull(manifest, contracts, universe);
  errors.push(...crossErrors);

  // A duplicate id is resolved deterministically above, but keeping quiet about it leaves the next
  // person wondering what they were validated against — the expensive half of module-toolkit#199.
  //
  // Only the ids THIS validation used are reported: the module's own and the ones it consumes. A
  // workspace with 27 modules plus the fleet's worktrees has duplicates by the handful that play no
  // part here, and a notice listing hundreds of unrelated directories goes unread — it buries the
  // one that mattered. For the same reason three directories are listed and the rest is counted.
  const relevant = new Set([manifest.id, ...dependencyIds(manifest.depends_on)]);
  for (const kind of ['queries', 'optional_queries', 'commands', 'optional_commands']) {
    for (const name of contracts.consumes[kind] ?? []) relevant.add(name.split('.')[0]);
  }
  const own = basename(dir);
  for (const { id, chosen, ignored } of shadowed) {
    if (!relevant.has(id)) continue;
    const total = ignored.length + 1;
    // For the module's OWN id the seed above rules, not the ranking: the manifest that counts is the
    // one in the directory under validation. Saying here that it was cross-checked against the
    // canonical checkout would describe the opposite of what happened — precisely the false
    // diagnosis these two issues kill.
    const isOwn = id === manifest.id;
    const used = isOwn ? own : chosen;
    const dropped = isOwn ? [chosen, ...ignored].filter((n) => n !== own) : ignored;
    const shown = dropped.slice(0, 3).map((n) => `\`${n}\``).join(', ');
    const rest = dropped.length > 3 ? ` y ${dropped.length - 3} más` : '';
    deferred.push(
      `id \`${id}\` declarado por ${total} directorios del workspace: ` +
        (isOwn ? `se valida el propio (\`${used}\`)` : `los contratos se cruzan contra \`${used}\``) +
        `, ignorando ${shown}${rest} (worktrees o copias del mismo módulo)`,
    );
  }

  return { errors, deferred };
}
