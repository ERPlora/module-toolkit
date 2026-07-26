// Scaffolding del toolkit (estilo Ionic): `startproject` (workspace contenedor de dev) y
// `g` (generate: module | view | command | query). Genera SOLO source + manifest — el toolkit
// es el "envoltorio" que aporta deps y config de build; el repo del módulo queda limpio.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ── startproject ────────────────────────────────────────────────────────────────────────────
export async function startproject(name) {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error('uso: erplora startproject <nombre>  (kebab-case: a-z, 0-9, guiones)');
  }
  const dir = resolve(process.cwd(), name);
  if (existsSync(dir) && existsSync(join(dir, 'package.json'))) {
    throw new Error(`ya existe un proyecto en ${dir}`);
  }
  console.log(`Creando workspace de módulos '${name}' en ${dir}`);

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
    devDependencies: {
      '@erplora/module-toolkit': fileDep(dir, TOOLKIT_DIR),
      '@erplora/outfitkit': fileDep(dir, join(HUB_PACKAGES, 'outfitkit')),
      '@erplora/module-sdk': fileDep(dir, join(HUB_PACKAGES, 'module-sdk')),
      '@erplora/module-types': fileDep(dir, join(HUB_PACKAGES, 'module-types')),
      '@ionic/core': '^8.8.0',
      lit: '^3.2.0',
    },
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
      ? `-- ${fullName}\n-- TODO: command declarativo. El runtime auto-inyecta hub_id + created_by/updated_by + soft-delete.\nUPDATE ${id}_${file} SET updated_at = CURRENT_TIMESTAMP WHERE id = :id;\n`
      : `-- ${fullName}\nSELECT * FROM ${id}_items WHERE is_deleted = 0 ORDER BY name;\n`;
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
  return `-- ${id}: esquema inicial (${dialect}). El runtime añade hub_id + is_deleted/deleted_at +
-- created_by/updated_by/created_at/updated_at por contrato; aquí solo el dominio.
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
-- e inyecta hub_id. Devuelve la página + total para el pager.
SELECT id, name, code, amount, created_at
FROM ${id}_${entity}
WHERE is_deleted = 0;
`;
}

function getQuery(id, entity) {
  return `-- ${id}.${entity}.get
SELECT id, name, code, amount, created_at, updated_at
FROM ${id}_${entity}
WHERE id = :id AND is_deleted = 0;
`;
}

function createCommand(id, entity) {
  return `-- ${id}.${entity}.create — hub_id + created_by/updated_by los inyecta el runtime.
INSERT INTO ${id}_${entity} (id, name, code, amount)
VALUES (:id, :name, :code, :amount);
`;
}

function viewComponent(id, entity, comp) {
  const klass = comp
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  return `import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
// 'define' por su subpath ligero (no arrastra el barrel de ok-*). 'ok-data-table' se auto-registra.
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';

// Web Component del módulo '${id}' (Lit). Mini-app: NO toca la BD; llama al SDK
// (erplora.query/queryPage/command/on). El cliente se obtiene de globalThis.erplora
// (lo inyecta el shell del Hub; en 'erplora dev' lo inyecta un cliente mock con fixtures).

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}

interface Item {
  id: string;
  name: string;
  code: string;
  amount: number;
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

export class ${klass} extends LitElement {
  static styles = css\`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .err { color:#d9480f; font-weight:600; }
  \`;

  @state() private newName = '';
  @state() private newCode = '';
  @state() private saving = false;
  @state() private formError = '';

  private ctrl!: ListController<Item>;

  private columns: DataTableColumn[] = [
    { key: 'name', header: 'Nombre', sortable: true, filterable: true, filterType: 'text' },
    { key: 'code', header: 'Código', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'amount',
      header: 'Importe',
      align: 'right',
      sortable: true,
      filterable: true,
      filterType: 'range',
      format: (r) => Number(r.amount).toFixed(2),
    },
  ];

  async firstUpdated(): Promise<void> {
    this.ctrl = createListController<Item>(
      erplora(),
      '${id}.${entity}.list',
      () => this.requestUpdate(),
      { pageSize: 50, sort: 'name', dir: 'asc' },
    );
    await this.ctrl.load();
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
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear';
    } finally {
      this.saving = false;
    }
  }

  render() {
    return html\`
      <div>
        <header><h2>${cap(entity)}</h2></header>
        <form class="form" @submit=\${(e: Event) => this.create(e)}>
          <ion-input placeholder="Nombre" .value=\${this.newName}
            @ionInput=\${(e: Event) => (this.newName = (e.target as HTMLInputElement).value)}></ion-input>
          <ion-input placeholder="Código" .value=\${this.newCode}
            @ionInput=\${(e: Event) => (this.newCode = (e.target as HTMLInputElement).value)}></ion-input>
          <ion-button type="submit" size="small" ?disabled=\${this.saving || !this.newName}>
            \${this.saving ? 'Guardando…' : 'Añadir'}
          </ion-button>
        </form>
        \${this.formError ? html\`<p class="err">\${this.formError}</p>\` : nothing}
        \${this.ctrl?.error ? html\`<p class="err">\${this.ctrl.error}</p>\` : nothing}
        <ok-data-table
          .serverSide=\${true}
          .columns=\${this.columns}
          .rows=\${this.ctrl?.rows ?? []}
          .total=\${this.ctrl?.total ?? 0}
          .page=\${this.ctrl?.state.page ?? 0}
          .pageSize=\${this.ctrl?.state.pageSize ?? 50}
          .sort=\${this.ctrl?.state.sort}
          .sortDir=\${this.ctrl?.state.dir ?? 'asc'}
          .searchable=\${true}
          .searchPlaceholder=\${'Buscar…'}
          .emptyMessage=\${this.ctrl?.loading ? 'Cargando…' : 'Sin datos.'}
          @pageChange=\${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)}
          @sortChange=\${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) =>
            this.ctrl.setSort(e.detail.sort, e.detail.dir)}
          @searchChange=\${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)}
          @filterChange=\${(e: CustomEvent<{ col: string; value: unknown }>) =>
            this.ctrl.setFilter(e.detail.col, e.detail.value)}
        ></ok-data-table>
      </div>
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
- \`fixtures/\` — datos mock que usa \`erplora dev\` para previsualizar sin backend.
- \`dist/${id}.esm.js\` — artefacto que va en el \`module.zip\` (lo genera \`erplora build\`).

\`\`\`sh
erplora dev ${id}      # previsualiza
erplora build ${id}    # compila el WC
\`\`\`
`;
}
