// Scaffolding del toolkit (estilo Ionic): `startproject` (workspace contenedor de dev) y
// `g` (generate: module | view | command | query). Genera SOLO source + manifest — el toolkit
// es el "envoltorio" que aporta deps y config de build; el repo del módulo queda limpio.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeContractsFile } from './contracts.mjs';

const TOOLKIT_DIR = resolve(fileURLToPath(import.meta.url), '../..'); // …/module-toolkit
const HUB_PACKAGES = resolve(TOOLKIT_DIR, '../hub/packages'); // …/hub/packages

// Escribe un archivo solo si no existe (idempotente). Devuelve true si lo creó.
function put(path, content) {
  if (existsSync(path)) {
    console.log(`  ↷ existe, no toco: ${relative(process.cwd(), path)}`);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`  ✓ ${relative(process.cwd(), path)}`);
  return true;
}

// `file:` dep relativa desde el proyecto hacia un paquete local (toolkit/hub) — robusto sea
// cual sea dónde se cree el proyecto.
function fileDep(fromDir, pkgDir) {
  let r = relative(fromDir, pkgDir);
  if (!r.startsWith('.')) r = './' + r;
  return `file:${r}`;
}

// OutfitKit is published on npm: same range the toolkit itself builds with (single source).
const TOOLKIT_PKG = JSON.parse(readFileSync(join(TOOLKIT_DIR, 'package.json'), 'utf8'));
const OUTFITKIT_RANGE = TOOLKIT_PKG.dependencies['@erplora/outfitkit'];

// Hub packages not published yet (hub#1371): linked with `file:` only when the folder really
// exists; otherwise a warning instead of a dangling link that `npm install` accepts silently.
const LOCAL_HUB_PACKAGES = ['module-sdk', 'module-types'];

// devDependencies of the workspace created by `startproject` (module-toolkit#361).
export function workspaceDevDependencies(
  dir,
  { toolkitDir = TOOLKIT_DIR, hubPackagesDir = HUB_PACKAGES } = {},
) {
  const devDependencies = {
    '@erplora/module-toolkit': fileDep(dir, toolkitDir),
    '@erplora/outfitkit': OUTFITKIT_RANGE,
  };
  const warnings = [];
  for (const name of LOCAL_HUB_PACKAGES) {
    const pkgDir = join(hubPackagesDir, name);
    if (existsSync(join(pkgDir, 'package.json'))) {
      devDependencies[`@erplora/${name}`] = fileDep(dir, pkgDir);
    } else {
      warnings.push({ code: 'local_package_missing', package: `@erplora/${name}`, path: pkgDir });
    }
  }
  devDependencies['@ionic/core'] = '^8.8.0';
  devDependencies.lit = '^3.2.0';
  return { devDependencies, warnings };
}

// ── startproject ────────────────────────────────────────────────────────────────────────────
export async function startproject(name, deps = {}) {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error('uso: erplora startproject <nombre>  (kebab-case: a-z, 0-9, guiones)');
  }
  const dir = resolve(process.cwd(), name);
  if (existsSync(dir) && existsSync(join(dir, 'package.json'))) {
    throw new Error(`ya existe un proyecto en ${dir}`);
  }
  console.log(`Creando workspace de módulos '${name}' en ${dir}`);
  const { devDependencies, warnings } = workspaceDevDependencies(dir, deps);

  const pkg = {
    name,
    private: true,
    type: 'module',
    description:
      'Workspace de desarrollo de módulos ERPlora (contenedor dev). Cada módulo en modules/<id> ' +
      'es su propio repo git, publicable de forma independiente. Ionic + OutfitKit instalados por defecto.',
    scripts: {
      build: 'erplora build',
      dev: 'erplora dev',
      validate: 'erplora validate',
    },
    devDependencies,
  };
  put(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // Registry público para @ionic/core (el npm global del equipo apunta a CodeArtifact → E401).
  put(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

  put(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          // Decoradores de Lit (@state/@property): igual que el build (esbuild/Vite).
          experimentalDecorators: true,
          useDefineForClassFields: false,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          // Tipos resueltos desde node_modules del workspace (ionic + outfitkit + sdk + lit).
          types: [],
        },
        include: ['modules/**/*.ts'],
        exclude: ['**/node_modules', '**/dist'],
      },
      null,
      2,
    ) + '\n',
  );

  put(join(dir, '.gitignore'), ['node_modules/', '*.log', '.DS_Store', ''].join('\n'));
  put(join(dir, 'modules', '.gitkeep'), '');
  put(join(dir, 'README.md'), projectReadme(name));

  console.log(`\nProyecto creado. Siguientes pasos:
  cd ${name}
  npm install            # instala toolkit + Ionic + OutfitKit + SDK + lit
  erplora g module miprimermodulo
  erplora dev miprimermodulo
  erplora build miprimermodulo`);

  for (const w of warnings) {
    console.warn(
      `\n⚠ ${w.package} no está en ${w.path}: NO se ha añadido a package.json.\n` +
        `  Aún no está publicado en npm (hub#1371): los módulos que lo importen no compilarán.\n` +
        `  Para usarlo ya, ejecuta startproject con el toolkit de un checkout que tenga ERPlora/hub\n` +
        `  como carpeta hermana (…/module-toolkit y …/hub).`,
    );
  }
}

// ── generate (g) ──────────────────────────────────────────────────────────────────────────────
export async function generate(kind, ...args) {
  switch (kind) {
    case 'module':
      return genModule(args[0]);
    case 'view':
      return genView(args[0], args[1]);
    case 'command':
      return genSql('command', args[0], args[1]);
    case 'query':
      return genSql('query', args[0], args[1]);
    default:
      throw new Error('uso: erplora g <module|view|command|query> …');
  }
}

// Localiza la carpeta `modules/` del workspace actual (cwd o cwd/modules). Si no hay workspace,
// usa cwd directamente (permite `g module` suelto).
function modulesRoot() {
  if (existsSync(join(process.cwd(), 'modules'))) return join(process.cwd(), 'modules');
  return process.cwd();
}

function assertId(id, what = 'id') {
  if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new Error(`${what} inválido '${id}' (snake_case: a-z, 0-9, guiones bajos; empieza por letra)`);
  }
}

function genModule(id) {
  assertId(id, 'module id');
  const dir = join(modulesRoot(), id);
  if (existsSync(join(dir, 'module.json'))) throw new Error(`ya existe un módulo en ${dir}`);
  console.log(`Generando módulo '${id}' en ${relative(process.cwd(), dir)}`);

  const entity = 'items';
  const comp = `erp-${id.replace(/_/g, '-')}-${entity}`;

  put(join(dir, 'module.json'), JSON.stringify(moduleManifest(id, entity, comp), null, 2) + '\n');
  // Dialecto único Postgres (ADR-0154): SQLite quedó deprecado, ya no se genera.
  put(join(dir, 'migrations', 'postgres', '001_init.sql'), initMigration(id, entity, 'Postgres'));
  put(join(dir, 'queries', `${entity}_list.sql`), listQuery(id, entity));
  put(join(dir, 'queries', `${entity}_get.sql`), getQuery(id, entity));
  put(join(dir, 'commands', `${entity}_create.sql`), createCommand(id, entity));
  put(join(dir, 'ui', 'components', comp, `${comp}.ts`), viewComponent(id, entity, comp));
  for (const lang of Object.keys(VIEW_UI)) {
    put(join(dir, 'locales', `${lang}.json`), JSON.stringify(moduleLocale(lang, id, entity), null, 2) + '\n');
  }
  put(join(dir, 'fixtures', `${id}.${entity}.list.json`), fixtureRows(entity));
  put(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ extends: '../../tsconfig.json', include: ['ui/**/*.ts'] }, null, 2) + '\n',
  );
  put(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@erplora/module-${id}`,
        private: true,
        version: '0.1.0',
        type: 'module',
        description: `Módulo ${id} de ERPlora (manifest declarativo + Web Component Lit). Se compila con el toolkit.`,
      },
      null,
      2,
    ) + '\n',
  );
  put(join(dir, '.gitignore'), ['node_modules/', 'target/', 'build/', '*.log', '.DS_Store', ''].join('\n'));
  put(join(dir, 'README.md'), moduleReadme(id, comp));

  // El contrato de interoperabilidad (ADR-0127) se DERIVA del manifest y del SQL que acabamos de
  // escribir, así que el generador puede calcularlo — y tiene que hacerlo: sin él, el primer
  // `erplora validate` de la desarrolladora sale en ROJO por un fichero que ella no puede saber
  // que existía (module-toolkit#80). `erplora contracts <id>` lo regenera cuando el módulo cambie.
  writeContractsFile(dir, JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')));
  console.log(`  ✓ ${relative(process.cwd(), join(dir, '.erplora/contracts.json'))}`);

  console.log(`\nMódulo '${id}' generado. Pruébalo:
  erplora dev ${id}        # preview con datos mock
  erplora build ${id}      # → modules/${id}/dist/${id}.esm.js`);
}

function genView(id, view) {
  assertId(id, 'module id');
  if (!view || !/^[a-z][a-z0-9_]*$/.test(view)) throw new Error('uso: erplora g view <module_id> <view_name>');
  const dir = join(modulesRoot(), id);
  if (!existsSync(join(dir, 'module.json'))) throw new Error(`no existe el módulo '${id}' (genera primero: erplora g module ${id})`);
  const comp = `erp-${id.replace(/_/g, '-')}-${view.replace(/_/g, '-')}`;
  console.log(`Generando vista '${comp}' en módulo '${id}'`);
  put(join(dir, 'ui', 'components', comp, `${comp}.ts`), viewComponent(id, view, comp));
  mergeViewLocales(dir);
  put(join(dir, 'fixtures', `${id}.${view}.list.json`), fixtureRows(view));
  console.log(`\nAñade la vista a navigation[] en modules/${id}/module.json si quieres que aparezca en el menú:
  { "id": "${view}", "label": "${cap(view)}", "icon": "list", "component": "${comp}" }`);
}

function genSql(kind, id, fullName) {
  assertId(id, 'module id');
  if (!fullName) throw new Error(`uso: erplora g ${kind} <module_id> <${kind}_name>  (p.ej. ${id}.orders.create)`);
  const dir = join(modulesRoot(), id);
  if (!existsSync(join(dir, 'module.json'))) throw new Error(`no existe el módulo '${id}'`);
  const file = fullName.replace(/\./g, '_');
  const sub = kind === 'command' ? 'commands' : 'queries';
  const sql =
    kind === 'command'
      ? `-- ${fullName}\n` +
        '-- Command declarativo. El runtime inyecta los BINDS (:hub_id, :current_user_id, :now…), no\n' +
        '-- las columnas ni el filtro: `hub_id = :hub_id` lo escribes tú o la sentencia alcanza filas\n' +
        '-- de otros hubs (module-toolkit#80).\n' +
        `UPDATE ${id}_${file} SET updated_at = CURRENT_TIMESTAMP, updated_by = :current_user_id\nWHERE hub_id = :hub_id AND id = :id;\n`
      : `-- ${fullName}\n` +
        '-- Acotado por hub: sin `hub_id = :hub_id` la consulta lee filas de otros hubs.\n' +
        `SELECT * FROM ${id}_items WHERE hub_id = :hub_id AND is_deleted = 0 ORDER BY name;\n`;
  put(join(dir, sub, `${file}.sql`), sql);
  console.log(`\nRegístralo en modules/${id}/module.json bajo "${kind === 'command' ? 'commands' : 'queries'}":
  "${fullName}": { "permission": "${id}.view_item", "sql": ${kind === 'command' ? `["${sub}/${file}.sql"]` : `"${sub}/${file}.sql"`} }`);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

// ── Plantillas de contenido ───────────────────────────────────────────────────────────────────

function moduleManifest(id, entity, comp) {
  return {
    id,
    name: cap(id),
    version: '0.1.0',
    agent: { description: `Módulo ${id}.`, keywords: [id, entity] },
    depends_on: [],
    permissions: [`${id}.view_item`, `${id}.add_item`, `${id}.change_item`, `${id}.delete_item`],
    role_permissions: {
      admin: ['*'],
      manager: [`${id}.view_item`, `${id}.add_item`, `${id}.change_item`, `${id}.delete_item`],
      employee: [`${id}.view_item`],
    },
    navigation: [{ id: entity, label: cap(entity), icon: 'list', component: comp }],
    migrations: {
      postgres: ['migrations/postgres/001_init.sql'],
    },
    queries: {
      [`${id}.${entity}.list`]: {
        permission: `${id}.view_item`,
        sql: `queries/${entity}_list.sql`,
        list: {
          search: ['name', 'code'],
          sort: ['name', 'code', 'amount', 'created_at'],
          default_sort: 'name',
          default_dir: 'asc',
          filters: { amount: { op: 'range' } },
          page_size: 50,
        },
        ai: { description: `Lista los ${entity} del módulo ${id}.` },
      },
      [`${id}.${entity}.get`]: {
        permission: `${id}.view_item`,
        sql: `queries/${entity}_get.sql`,
        ai: { description: `Detalle de un ${entity.replace(/s$/, '')} por id.` },
      },
    },
    commands: {
      [`${id}.${entity}.create`]: {
        permission: `${id}.add_item`,
        transaction: true,
        sql: [`commands/${entity}_create.sql`],
        emit: [`${id}.${entity.replace(/s$/, '')}.created`],
        ai: { description: `Crea un ${entity.replace(/s$/, '')} en ${id}.` },
      },
    },
    ui: { entry: `dist/${id}.esm.js` },
  };
}

function initMigration(id, entity, dialect) {
  return `-- ${id}: esquema inicial (${dialect}). Las columnas del CONTRATO DE FILA (hub_id,
-- is_deleted/deleted_at, created_by/updated_by, created_at/updated_at) se declaran AQUÍ y las
-- escribe el SQL del módulo: el runtime aporta los binds (:hub_id, :current_user_id…), no las
-- columnas — creer lo contrario es lo que dejaba el INSERT sin hub_id (module-toolkit#80).
-- OJO: ningun punto y coma dentro de un comentario. Los hubs pineados a tags parten el
-- fichero por ahi y rechazan el modulo ENTERO al instalar (module-toolkit#70, hub#1027).
CREATE TABLE IF NOT EXISTS ${id}_${entity} (
  id          TEXT PRIMARY KEY,
  hub_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  code        TEXT,
  amount      REAL NOT NULL DEFAULT 0,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_by  TEXT,
  updated_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_${id}_${entity}_name ON ${id}_${entity}(hub_id, name);
`;
}

function listQuery(id, entity) {
  return `-- ${id}.${entity}.list — el runtime aplica search/sort/filtros/paginación (motor de listas)
-- e inyecta el bind :hub_id. Devuelve la página + total para el pager.
-- El FILTRO de tenancy lo escribe el módulo: el motor de listas no lo añade, y sin él la lista
-- devuelve filas de OTROS hubs allí donde la base de datos está compartida (module-toolkit#80).
SELECT id, name, code, amount, created_at
FROM ${id}_${entity}
WHERE hub_id = :hub_id AND is_deleted = 0;
`;
}

function getQuery(id, entity) {
  return `-- ${id}.${entity}.get — acotado por hub: un id de otro hub no se lee desde aquí.
SELECT id, name, code, amount, created_at, updated_at
FROM ${id}_${entity}
WHERE hub_id = :hub_id AND id = :id AND is_deleted = 0;
`;
}

function createCommand(id, entity) {
  return `-- ${id}.${entity}.create
-- El runtime inyecta los BINDS (:hub_id, :current_user_id, :now…) — nunca las COLUMNAS. Nombrarlas
-- es cosa del módulo: un INSERT que no escriba \`hub_id\` deja NULL una columna NOT NULL y falla en
-- TODOS los hubs (module-toolkit#80). PREPARA bien, así que \`validate --pg\` no lo vería: quien lo
-- comprueba es la puerta de tenancy de \`erplora validate\`.
INSERT INTO ${id}_${entity} (id, hub_id, name, code, amount, created_by, updated_by)
VALUES (:id, :hub_id, :name, :code, :amount, :current_user_id, :current_user_id);
`;
}

// The view's visible text, in the module catalogue (ADR-0055): English is the source, Spanish its
// translation. «Add» belongs to the toolbar button ok-data-table paints itself; the button that
// sends the create form says «Save», like every other create panel of the product
// (module-toolkit#366 — pricing#50, customers#96, staff#74 had to be fixed by hand).
const VIEW_UI = {
  en: {
    colName: 'Name',
    colCode: 'Code',
    colAmount: 'Amount',
    searchPlaceholder: 'Search…',
    loading: 'Loading…',
    empty: 'No records yet.',
    save: 'Save',
    saving: 'Saving…',
    createFailed: 'Could not save. Check the data and try again.',
  },
  es: {
    colName: 'Nombre',
    colCode: 'Código',
    colAmount: 'Importe',
    searchPlaceholder: 'Buscar…',
    loading: 'Cargando…',
    empty: 'Todavía no hay registros.',
    save: 'Guardar',
    saving: 'Guardando…',
    createFailed: 'No se pudo guardar. Revisa los datos y vuelve a intentarlo.',
  },
};

/** `locales/<lang>.json` of a new module: its name, its menu entry and the view's strings. */
function moduleLocale(lang, id, entity) {
  return { name: cap(id), navigation: { [entity]: { label: cap(entity) } }, ui: { ...VIEW_UI[lang] } };
}

/**
 * Brings the view's keys into the module catalogue: creates `locales/<lang>.json` when missing and
 * only ADDS the keys it lacks — a translation the developer already wrote is never overwritten.
 */
function mergeViewLocales(dir) {
  for (const lang of Object.keys(VIEW_UI)) {
    const path = join(dir, 'locales', `${lang}.json`);
    const catalog = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    const ui = catalog.ui && typeof catalog.ui === 'object' ? catalog.ui : {};
    const missing = Object.keys(VIEW_UI[lang]).filter((k) => !(k in ui));
    if (existsSync(path) && missing.length === 0) continue;
    catalog.ui = { ...ui, ...Object.fromEntries(missing.map((k) => [k, VIEW_UI[lang][k]])) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n');
    console.log(`  ✓ ${relative(process.cwd(), path)} (+${missing.length} ui keys)`);
  }
}

function viewComponent(id, entity, comp) {
  const klass = comp
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  return `import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
// 'define' through its light subpath (does not pull the ok-* barrel). 'ok-data-table' registers itself.
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
// The module's i18n catalogue (ADR-0055): esbuild inlines these JSON files into the bundle. Every
// visible string goes through \`erplora().t(CATALOG, 'ui.key')\` (active language, fallback en → key).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

// Web Component of the '${id}' module (Lit). A mini-app: it never touches the database, it calls the
// SDK (erplora.query/queryPage/command/on). The client lives in globalThis.erplora (the Hub shell
// injects it; under 'erplora dev' a mock client backed by the fixtures does).

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** Module i18n (ADR-0055): active language + translation from the catalogue. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

interface Item {
  id: string;
  name: string;
  code: string;
  amount: number;
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK not initialised by the shell');
  return c;
}

const t = (key: string): string => erplora().t(CATALOG, key);

export class ${klass} extends LitElement {
  static styles = css\`
    :host { display:flex; flex-direction:column; height:100%; min-height:0; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    ok-data-table { flex:1 1 auto; min-height:0; }
    /* The create form lives in the table's side panel (narrow): the fields go STACKED. */
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    .err { color:var(--ion-color-danger, #c5000f); font-weight:600; margin:0; }
  \`;

  @state() private newName = '';
  @state() private newCode = '';
  @state() private saving = false;
  @state() private formError = '';

  private ctrl!: ListController<Item>;

  // A getter, not a field: the headers follow the active language on every render (ADR-0055).
  private get columns(): DataTableColumn[] {
    return [
      { key: 'name', header: t('ui.colName'), sortable: true, filterable: true, filterType: 'text' },
      { key: 'code', header: t('ui.colCode'), sortable: true, filterable: true, filterType: 'text' },
      {
        key: 'amount',
        header: t('ui.colAmount'),
        align: 'right',
        sortable: true,
        filterable: true,
        filterType: 'range',
        format: (r) => Number(r.amount).toFixed(2),
      },
    ];
  }

  private readonly onLocaleChange = (): void => this.requestUpdate();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
  }

  disconnectedCallback(): void {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback();
  }

  async firstUpdated(): Promise<void> {
    this.ctrl = createListController<Item>(
      erplora(),
      '${id}.${entity}.list',
      () => this.requestUpdate(),
      { pageSize: 50, sort: 'name', dir: 'asc' },
    );
    await this.ctrl.load();
  }

  private dataTable(): { close(): void } | null {
    return this.renderRoot.querySelector('ok-data-table') as { close(): void } | null;
  }

  private async create(ev: Event): Promise<void> {
    ev.preventDefault();
    if (!this.newName.trim()) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('${id}.${entity}.create', {
        name: this.newName.trim(),
        code: this.newCode.trim(),
        amount: 0,
      });
      this.newName = '';
      this.newCode = '';
      this.dataTable()?.close(); // the create panel closes itself once the row exists
      await this.ctrl.load();
    } catch (e) {
      // Never the server text on screen: it can carry driver internals («db: sqlx: …», pricing#29).
      // Map the stable error codes of your commands to their own keys when you add them.
      console.error('${id}.${entity}.create failed', e);
      this.formError = t('ui.createFailed');
    } finally {
      this.saving = false;
    }
  }

  // The view title is painted by the shell's top bar (from locales → navigation): not repeated here.
  // The toolbar «+ Add» of ok-data-table opens the create panel; its form sends with «Save».
  render() {
    return html\`
      \${this.ctrl?.error ? html\`<p class="err">\${this.ctrl.error}</p>\` : nothing}
      <ok-data-table
        .serverSide=\${true}
        .fill=\${true}
        .addable=\${true}
        .columns=\${this.columns}
        .rows=\${this.ctrl?.rows ?? []}
        .total=\${this.ctrl?.total ?? 0}
        .page=\${this.ctrl?.state.page ?? 0}
        .pageSize=\${this.ctrl?.state.pageSize ?? 50}
        .sort=\${this.ctrl?.state.sort}
        .sortDir=\${this.ctrl?.state.dir ?? 'asc'}
        .searchable=\${true}
        .searchPlaceholder=\${t('ui.searchPlaceholder')}
        .emptyMessage=\${this.ctrl?.loading ? t('ui.loading') : t('ui.empty')}
        @pageChange=\${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)}
        @pageSizeChange=\${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)}
        @sortChange=\${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) =>
          this.ctrl.setSort(e.detail.sort, e.detail.dir)}
        @searchChange=\${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)}
        @filterChange=\${(e: CustomEvent<{ col: string; value: unknown }>) =>
          this.ctrl.setFilter(e.detail.col, e.detail.value)}
      >
        <!-- Projected ALWAYS (even with the panel closed): otherwise «+» would open an empty panel. -->
        <form slot="create" class="form" @submit=\${(e: Event) => this.create(e)}>
          <ion-input mode="md" fill="outline" label-placement="floating" label=\${t('ui.colName')}
            .value=\${this.newName}
            @ionInput=\${(e: Event) => (this.newName = String((e.target as HTMLInputElement).value ?? ''))}></ion-input>
          <ion-input mode="md" fill="outline" label-placement="floating" label=\${t('ui.colCode')}
            .value=\${this.newCode}
            @ionInput=\${(e: Event) => (this.newCode = String((e.target as HTMLInputElement).value ?? ''))}></ion-input>
          \${this.formError ? html\`<p class="err" role="alert">\${this.formError}</p>\` : nothing}
          <ion-button type="submit" ?disabled=\${this.saving || !this.newName.trim()}>\${this.saving ? t('ui.saving') : t('ui.save')}</ion-button>
        </form>
      </ok-data-table>
    \`;
  }
}

define('${comp}', ${klass});
`;
}

function fixtureRows(entity) {
  const names = ['Alfa', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
  const rows = names.map((n, i) => ({
    id: `${entity}-${i + 1}`,
    name: n,
    code: `${entity.slice(0, 3).toUpperCase()}-${100 + i}`,
    amount: Math.round((i + 1) * 12.5 * 100) / 100,
    created_at: `2026-01-0${(i % 9) + 1}T10:00:00Z`,
  }));
  return JSON.stringify(rows, null, 2) + '\n';
}

function projectReadme(name) {
  return `# ${name}

Workspace de desarrollo de módulos ERPlora (contenedor **solo dev**). Generado con
\`@erplora/module-toolkit\` (estilo Ionic). Cada módulo en \`modules/<id>/\` es **su propio repo git**
y se publica al marketplace de forma independiente — el contenedor no es la unidad publicable.

Ionic (\`@ionic/core\`) y OutfitKit (\`@erplora/outfitkit\`) están **instalados por defecto**.

## Uso

\`\`\`sh
npm install                       # toolkit + Ionic + OutfitKit + SDK + lit
erplora g module inventory        # nuevo módulo
erplora dev inventory             # preview con datos mock (CSP-safe), http://localhost:4321
erplora build inventory           # → modules/inventory/dist/inventory.esm.js
erplora validate inventory        # manifest + CSP
erplora pack inventory            # module.zip + SHA256 (para publicar)
\`\`\`

> El build/preview los sirve el toolkit; los módulos no declaran deps de build.
`;
}

function moduleReadme(id, comp) {
  return `# ${id}

Módulo ERPlora (declarativo + Web Component Lit). Repo independiente; se desarrolla dentro de un
workspace creado con \`erplora startproject\`.

- \`module.json\` — manifest (queries/commands/navigation/permissions).
- \`ui/components/${comp}/${comp}.ts\` — el Web Component (Lit) que usa \`ok-data-table\`.
- \`queries/\`, \`commands/\`, \`migrations/\` — SQL declarativo (Postgres).
- \`locales/en.json\`, \`locales/es.json\` — textos del módulo (nombre, menú y \`ui.*\` de las vistas): inglés fuente + español.
- \`fixtures/\` — datos mock que usa \`erplora dev\` para previsualizar sin backend.
- \`dist/${id}.esm.js\` — artefacto que va en el \`module.zip\` (lo genera \`erplora build\`).

\`\`\`sh
erplora dev ${id}      # previsualiza
erplora build ${id}    # compila el WC
\`\`\`
`;
}
