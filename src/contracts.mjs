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
import { join, relative } from 'node:path';
import ts from 'typescript';

// ── Reconocedores declarativos ────────────────────────────────────────────────────────────────
// Un reconocedor = nombre de la función/método del SDK + en qué argumento viaja el contrato +
// de qué clase es. Añadir un método nuevo al SDK = una línea aquí (y su test), no un caso especial.
export const RECOGNIZERS = {
  query: { kind: 'query', argument: 0, required: true },
  queryAll: { kind: 'query', argument: 0, required: true },
  queryPage: { kind: 'query', argument: 0, required: true },
  queryOptional: { kind: 'query', argument: 0, required: false },
  command: { kind: 'command', argument: 0, required: true },
  on: { kind: 'event', argument: 0 },
  loadSlot: { kind: 'slot', argument: 0 },
  createListController: { kind: 'query', argument: 1, required: true },
};

/** Nombre con namespace: `modulo.operacion[...]`. El primer segmento identifica al dueño. */
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

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
  const sets = { queries: new Set(), optional_queries: new Set(), commands: new Set(), events: new Set(), slots: new Set() };
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
              const bucket =
                recognized.kind === 'query' && recognized.required === false
                  ? 'optional_queries'
                  : recognized.kind === 'query'
                    ? 'queries'
                    : recognized.kind === 'command'
                      ? 'commands'
                      : recognized.kind === 'event'
                        ? 'events'
                        : 'slots';
              sets[bucket].add(name);
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
  for (const k of ['queries', 'optional_queries', 'commands', 'events', 'slots']) {
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
 * El universo del workspace: qué ofrece cada módulo (leído de sus module.json vecinos).
 * En el marketplace/install-plan el MISMO validador recibe otro universo — cambia el conjunto,
 * no el motor.
 */
export function loadUniverse(modulesDir) {
  const universe = new Map();
  if (!existsSync(modulesDir)) return universe;
  for (const name of readdirSync(modulesDir)) {
    const manifestPath = join(modulesDir, name, 'module.json');
    if (!existsSync(manifestPath)) continue;
    let m;
    try {
      m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue; // un manifest ilegible no tumba la validación de los demás
    }
    const emits = new Set();
    for (const cmd of Object.values(m.commands ?? {})) for (const e of cmd.emit ?? []) emits.add(e);
    universe.set(m.id, {
      queries: new Set(Object.keys(m.queries ?? {})),
      commands: new Set(Object.keys(m.commands ?? {})),
      emits,
    });
  }
  return universe;
}

/**
 * Cruza el contrato consumido + el manifest contra el universo. Devuelve `{ errors, deferred }`:
 *   - errors: contratos rotos → el build FALLA (error, nunca warning: un warning es el mismo
 *     silencio que este contrato mata)
 *   - deferred: dependencias declaradas que no están en el universo (CI por-módulo sin el
 *     workspace al lado) → constancia de lo no comprobado; lo cubren la publicación/instalación
 */
/**
 * Namespace RESERVADO del core en el dispatcher (ADR-0188): lo sirve el runtime, no un módulo.
 * Un módulo lo consume como cualquier otra query (`erplora().query('hub.users.list')`) pero NO lo
 * declara en `depends_on`: no es instalable ni participa del topo-orden.
 *
 * La lista es el espejo de `CORE_QUERIES` en `hub/crates/runtime/src/hub_users.rs`. Si el runtime
 * gana una capacidad de core nueva, se añade aquí — si no, el gate la rechaza como typo.
 */
const CORE_NAMESPACE = 'hub';
const CORE_OPERATIONS = {
  queries: ['hub.users.list', 'hub.roles.list'],
  commands: [],
};

export function crossValidateFull(manifest, contracts, universe) {
  const errors = [];
  const deferred = [];
  const me = manifest.id;
  const deps = new Set(manifest.depends_on ?? []);
  const missingDeps = new Set([...deps].filter((d) => !universe.has(d)));
  for (const d of missingDeps) deferred.push(`depends_on \`${d}\` no está en el workspace: su contrato se comprobará en la publicación/instalación`);

  const allEmits = new Set();
  for (const mod of universe.values()) for (const e of mod.emits) allEmits.add(e);

  const checkOperation = (name, opKind, { optional = false } = {}) => {
    const owner = name.split('.')[0];
    const surface = opKind === 'command' ? 'commands' : 'queries';
    // El CORE no es un módulo (ADR-0188): `hub.` es su namespace reservado en el dispatcher. No se
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
      // queryOptional a un módulo fuera del universo, se resuelve en la instalación.
      if (!optional && !missingDeps.has(owner) && !deps.has(owner)) {
        errors.push(`\`${name}\`: llamada a \`${owner}\` que no está en depends_on de \`${me}\``);
      }
      return;
    }
    if (!optional && !deps.has(owner)) {
      errors.push(`\`${name}\`: llamada a \`${owner}\` que no está en depends_on de \`${me}\` (si la integración es opcional, usa queryOptional)`);
    }
    if (!universe.get(owner)[surface].has(name)) {
      errors.push(`\`${name}\`: no existe en el manifest de \`${owner}\`${optional ? ' (queryOptional permite AUSENCIA del módulo, no contratos rotos)' : ''}`);
    }
  };

  for (const q of contracts.consumes.queries) checkOperation(q, 'query');
  for (const q of contracts.consumes.optional_queries) checkOperation(q, 'query', { optional: true });
  for (const c of contracts.consumes.commands) checkOperation(c, 'command');

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
      if (!surface || !surface.queries.has(name)) {
        errors.push(`reads de \`${cmdName}\`: la query \`${name}\` no existe${surface ? ` en \`${owner}\`` : ''}`);
      }
    }
  }

  // Eventos: hoy muchos se emiten DINÁMICAMENTE desde el handler WASM (`sale.completed`,
  // `kitchen.order.fired`) y no son declarables sin doble emisión (el runtime emite lo declarado
  // ADEMÁS de lo del handler, y aún no hay dedup — fase 2). Hasta que la fase 3 haga obligatoria
  // la declaración de emisiones, un evento que nadie declara se APLAZA con constancia, no error:
  // un validador que error-ea en falso se ignora, y eso mata el contrato entero. (Que el emisor no
  // esté instalado en un hub concreto tampoco es error: lo decide la instalación, severidad info.)
  const eventKnown = (ev) => allEmits.has(ev);
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

  const universe = loadUniverse(join(dir, '..'));
  const contracts = buildContracts(dir, manifest);
  const { errors: crossErrors, deferred } = crossValidateFull(manifest, contracts, universe);
  errors.push(...crossErrors);

  return { errors, deferred };
}
