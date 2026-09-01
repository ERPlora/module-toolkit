// `erplora dev [id]`: preview local tipo Hub. Boilerplate con componentes Ionic (ion-list sidebar,
// ion-card launcher, ion-header/ion-toolbar, ion-segment inferior, ion-toggle, ion-buttons) + un
// drawer derecho (inspector) con contenido Ionic. Registra TODOS los módulos del workspace en una
// página main; al pulsar uno carga su navegación en el ion-segment de abajo (igual que el Hub) y
// monta su Web Component. Inyecta `globalThis.erplora` MOCK (fixtures o sintético). CSP estricta.
//
//   erplora dev            → todos los módulos del workspace (página main de registro)
//   erplora dev <id>       → igual, pero preselecciona ese módulo
//
// Nota: el layout (sidebar/drawer) es CSS flex por robustez; los COMPONENTES son Ionic + OutfitKit.
// (ion-split-pane/ion-menu sin router no maquetan bien fuera del shell real del Hub.)
import { context as esContext } from 'esbuild';
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { erploraResolvePlugin } from './resolve-plugin.mjs';
import {
  createBuildStatus,
  buildStatusPlugin,
  servesErrorOverlay,
  overlayScript,
} from './dev-build-status.mjs';

// Ionic: componentes registrados en el preview (en el Hub real los provee el shell).
const IONIC = [
  'app', 'content', 'header', 'toolbar', 'title', 'buttons', 'button', 'icon', 'input', 'textarea',
  'select', 'select-option', 'checkbox', 'toggle', 'item', 'label', 'list', 'list-header', 'note',
  'chip', 'badge', 'card', 'card-content', 'card-header', 'card-title', 'card-subtitle', 'spinner',
  'searchbar', 'segment', 'segment-button', 'footer', 'modal', 'popover', 'datetime', 'range',
  'radio', 'radio-group', 'grid', 'row', 'col', 'alert',
];

const TSCONFIG_RAW = { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } };

export function collectTs(p, out = []) {
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(p, name);
    if (statSync(full).isDirectory()) collectTs(full, out);
    // Solo producción: los tests colocados junto al componente (TDD) arrastran vitest al
    // harness y matan el preview en blanco — mismo bug que resolveEntry (build.mjs, 07-13).
    else if (
      extname(full) === '.ts' &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.spec.ts')
    ) out.push(full);
  }
  return out;
}

function loadFixtures(dir, into) {
  const fdir = join(dir, 'fixtures');
  if (!existsSync(fdir)) return;
  for (const f of readdirSync(fdir)) {
    if (!f.endsWith('.json')) continue;
    try {
      into[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(fdir, f), 'utf8'));
    } catch {
      /* ignora json inválido */
    }
  }
}

// Reúne los módulos a cargar. Con `single` activo, solo ese; si no, todos los del workspace.
function collectModules(rootDir, single) {
  const mods = [];
  const fixtures = {};
  const wcFiles = [];
  const dirs = single
    ? [single]
    : readdirSync(rootDir)
        .map((n) => join(rootDir, n))
        .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'module.json')))
        .sort();
  for (const dir of dirs) {
    const compDir = join(dir, 'ui', 'components');
    const ts = existsSync(compDir) ? collectTs(compDir) : [];
    if (!ts.length) continue; // módulos sin UI no se montan en el preview
    const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
    mods.push(manifest);
    wcFiles.push(...ts);
    loadFixtures(dir, fixtures);
  }
  return { mods, fixtures, wcFiles };
}

// Exportada para test (module-toolkit#133): la fuente generada es lo que corre en el navegador, y
// la única forma honesta de probar que el preview resuelve `emit` en sus dos formas
// (ERPlora/hub#1076) es ejecutar ESTE texto, no una reimplementación en el test.
export function harnessEntry(manifests, fixtures, wcFiles, preselect) {
  const ionicImports = IONIC.map(
    (c, i) => `import { defineCustomElement as i${i} } from '@ionic/core/components/ion-${c}.js';`,
  ).join('\n');
  const ionicDefines = `[${IONIC.map((_, i) => `i${i}`).join(',')}].forEach((d) => { try { d(); } catch {} });`;
  const wcImports = wcFiles.map((f) => `import ${JSON.stringify(f)};`).join('\n');

  return `${ionicImports}
import { initialize } from '@ionic/core/components';
import '@ionic/core/css/core.css';
import '@ionic/core/css/normalize.css';
import '@ionic/core/css/structure.css';
import '@ionic/core/css/typography.css';
import '@ionic/core/css/padding.css';
import { addIcons } from 'ionicons';
import * as __ICONS from 'ionicons/icons';
// Inicializa Ionic (config global + mode) para que los componentes adopten su display/estilo.
initialize({ mode: 'md' });
${ionicDefines}
// Registra TODAS las ionicons inline (sin fetch -> CSP-safe). Por nombre camelCase y kebab-case.
{ const im = {}; for (const [k, v] of Object.entries(__ICONS)) { if (typeof v === 'string') { im[k] = v; im[k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()] = v; } } addIcons(im); }
${wcImports}

const MODULES = ${JSON.stringify(manifests)};
const FIXTURES = ${JSON.stringify(fixtures)};
const PRESELECT = ${JSON.stringify(preselect || null)};

// ── Cliente mock (transport en memoria) ─────────────────────────────────────────────────────
const listeners = new Map();
function emit(event, payload) { (listeners.get(event) || []).forEach((cb) => { try { cb(payload); } catch {} }); }
// Nombre de un entry de \`emit\`, en cualquiera de sus dos formas (ERPlora/hub#1076,
// ERPlora/module-toolkit#133): el string plano de siempre, o \`{event, dedup_key}\`.
function emitName(e) { return typeof e === 'string' ? e : e.event; }
const QByName = {};
const CByName = {};
for (const m of MODULES) { Object.assign(QByName, m.queries || {}); Object.assign(CByName, m.commands || {}); }

function synth(name) {
  const cfg = (QByName[name] && QByName[name].list) || {};
  const cols = [...new Set([...(cfg.search || []), ...(cfg.sort || [])])].filter((c) => c !== 'id');
  const words = ['Alfa','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India','Juliet','Kilo','Lima'];
  return words.map((w, i) => {
    const row = { id: 'row-' + (i + 1) };
    for (const c of cols) {
      if (/_at$/.test(c)) row[c] = '2026-01-' + String((i % 28) + 1).padStart(2, '0') + 'T10:00:00Z';
      else if (/price|amount|total|cost|stock|qty|quantity|count|num/i.test(c)) row[c] = Math.round((i + 1) * 12.5 * 100) / 100;
      else if (/^is_|active|enabled|paid/i.test(c)) row[c] = i % 2;
      else row[c] = w + (c === (cfg.search || [])[0] ? '' : ' ' + c);
    }
    return row;
  });
}
function rowsFor(name) {
  if (FIXTURES[name]) return FIXTURES[name];
  const k = Object.keys(FIXTURES).find((x) => x === name || x.endsWith(name));
  if (k) return FIXTURES[k];
  return synth(name);
}
function applyList(rows, p, name) {
  let r = [...rows];
  const cfg = (QByName[name] && QByName[name].list) || {};
  if (p.search) {
    const s = String(p.search).toLowerCase();
    const fields = cfg.search || Object.keys(r[0] || {});
    r = r.filter((row) => fields.some((f) => String(row[f] ?? '').toLowerCase().includes(s)));
  }
  for (const [col, val] of Object.entries(p.filters || {})) {
    if (val == null || val === '') continue;
    if (typeof val === 'object' && ('from' in val || 'to' in val)) {
      if (val.from != null && val.from !== '') r = r.filter((row) => Number(row[col]) >= Number(val.from));
      if (val.to != null && val.to !== '') r = r.filter((row) => Number(row[col]) <= Number(val.to));
    } else r = r.filter((row) => String(row[col]) === String(val));
  }
  if (p.sort) {
    const dir = p.dir === 'desc' ? -1 : 1;
    r.sort((a, b) => {
      const x = a[p.sort], y = b[p.sort], n = Number(x), m = Number(y);
      if (!Number.isNaN(n) && !Number.isNaN(m)) return (n - m) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }
  return r;
}
globalThis.erplora = {
  async queryPage(name, params) {
    const filtered = applyList(rowsFor(name), params, name);
    const offset = params.offset || 0, limit = params.limit || 50;
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
  },
  async query(name, params) {
    const r = rowsFor(name);
    if (Array.isArray(r)) return params && params.id ? r.find((x) => x.id === params.id) || r[0] : r;
    return r;
  },
  async command(name, payload) {
    ((CByName[name] || {}).emit || []).forEach((ev) => emit(emitName(ev), payload));
    return { ok: true, id: 'new-' + Math.floor(performance.now()) };
  },
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
    return () => { const a = listeners.get(event); const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
  },
  // ── Superficie del ErploraClient real que los WC consumen (paridad con el SDK) ──
  // Sin esto, cualquier componente que use i18n o dinero muere en render dentro del
  // preview (t is not a function) y la página queda vacía con el error solo en consola.
  locale: 'es',
  currency: 'EUR',
  /** i18n del módulo (ADR-0055): idioma activo con fallback a en → clave pelada. */
  t(catalog, key, params) {
    const path = key.split('.');
    const dig = (o) => path.reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
    let v = dig((catalog || {})[this.locale]) ?? dig((catalog || {}).en) ?? key;
    if (params && typeof v === 'string') for (const [k, val] of Object.entries(params)) v = v.replaceAll('{' + k + '}', String(val));
    return v;
  },
  /** Dinero (ADR-0007/0123): formatMoney recibe CÉNTIMOS y divide; formatAmount unidades. */
  formatMoney(cents, opts) {
    const cur = (opts && opts.currency) || this.currency;
    return new Intl.NumberFormat((opts && opts.locale) || 'es-ES', { style: 'currency', currency: cur }).format((Number(cents) || 0) / 100);
  },
  formatAmount(units, opts) {
    const cur = (opts && opts.currency) || this.currency;
    return new Intl.NumberFormat((opts && opts.locale) || 'es-ES', { style: 'currency', currency: cur }).format(Number(units) || 0);
  },
  /** TODAS las filas (ADR-0124): el preview no pagina fixtures. */
  async queryAll(name, params) {
    const r = rowsFor(name);
    return Array.isArray(r) ? applyList(r, params || {}, name) : [];
  },
  /** Slots cross-módulo (ADR-0043): el preview no compone módulos → vacío. */
  async loadSlot() { return []; },
};

// ── Shell (layout CSS robusto + componentes Ionic) ────────────────────────────────────────────
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

let current = null;

window.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');

  const title = el('ion-title', { text: 'Inicio' });
  const view = el('ion-content', { id: 'tk-view', class: 'tk-content' });
  const seg = el('ion-segment', { id: 'tk-seg', scrollable: 'true' });
  const footer = el('ion-footer', { id: 'tk-footer', class: 'ion-no-border', style: 'display:none' },
    el('ion-toolbar', { class: 'ion-no-border' }, seg));
  seg.addEventListener('ionChange', (e) => showView(e.detail.value));

  // Sidebar: contenedor flex (layout) con ion-list/ion-item Ionic dentro.
  const sideList = el('ion-list', { lines: 'none' },
    el('ion-item', { button: 'true', detail: 'false', onclick: () => openHome() }, el('ion-label', { text: 'Inicio' })),
    el('ion-list-header', {}, el('ion-label', { text: 'Módulos' })),
    ...MODULES.map((m) =>
      el('ion-item', { button: 'true', detail: 'false', onclick: () => openModule(m.id) }, el('ion-label', { text: m.name || m.id }))),
  );
  const sidebar = el('aside', { class: 'tk-sidebar' },
    el('div', { class: 'tk-brand' }, 'ERPlora · módulos', el('div', { class: 'tk-brand-sub', text: 'dev preview' })),
    el('div', { class: 'tk-side-scroll' }, sideList));

  // Header Ionic con botón inspector (abre el drawer derecho).
  const inspBtn = el('ion-button', { fill: 'clear', onclick: () => toggleOverlay() }, el('ion-icon', { name: 'information-circle-outline', slot: 'icon-only' }));
  const header = el('ion-header', {}, el('ion-toolbar', {}, title, el('ion-buttons', { slot: 'end' }, inspBtn)));
  const main = el('div', { class: 'tk-main' }, header, view, footer);

  // Drawer derecho (inspector): panel CSS con contenido Ionic (ion-header + ion-list).
  const scrim = el('div', { class: 'tk-scrim', onclick: () => toggleOverlay(false) });
  const inspList = el('ion-list', {});
  const inspector = el('aside', { class: 'tk-overlay' },
    el('ion-header', {}, el('ion-toolbar', {},
      el('ion-title', { text: 'Inspector' }),
      el('ion-buttons', { slot: 'end' }, el('ion-button', { fill: 'clear', onclick: () => toggleOverlay(false) }, el('ion-icon', { name: 'close', slot: 'icon-only' }))))),
    el('ion-content', { class: 'ion-padding' }, inspList));

  root.appendChild(el('ion-app', {}, el('div', { class: 'tk-layout' }, sidebar, main), scrim, inspector));

  function showView(comp) {
    view.innerHTML = '';
    view.classList.add('tk-fixed'); // ion-content no scrollea en vista de módulo
    // Wrapper que llena el alto de ion-content: la tabla en modo fill hace scroll interno.
    if (comp) view.appendChild(el('div', { class: 'tk-view-fill' }, document.createElement(comp)));
  }
  window.__showView = showView;

  function openHome() {
    current = null;
    title.textContent = 'Inicio';
    footer.style.display = 'none';
    inspList.innerHTML = '';
    view.innerHTML = '';
    view.classList.remove('tk-fixed'); // el launcher sí scrollea (grid de módulos)
    const grid = el('div', { class: 'tk-grid' });
    for (const m of MODULES) {
      const navs = (m.navigation || []).length;
      const q = Object.keys(m.queries || {}).length, c = Object.keys(m.commands || {}).length;
      grid.appendChild(
        el('ion-card', { button: 'true', class: 'tk-card', onclick: () => openModule(m.id) },
          el('ion-card-header', {},
            el('ion-card-title', { text: m.name || m.id }),
            el('ion-card-subtitle', { text: \`\${navs} vista(s) · \${q} queries · \${c} commands\` })),
          el('ion-card-content', { text: m.id })),
      );
    }
    view.appendChild(el('div', { class: 'ion-padding' },
      el('h2', { class: 'tk-h2', text: 'Módulos registrados' }),
      el('p', { class: 'tk-sub', text: \`\${MODULES.length} módulo(s) en el workspace. Pulsa uno para cargarlo.\` }),
      grid));
  }
  window.__openHome = openHome;

  function openModule(id) {
    const m = MODULES.find((x) => x.id === id);
    if (!m) return;
    current = m;
    title.textContent = m.name || m.id;
    seg.innerHTML = '';
    const navs = m.navigation || [];
    navs.forEach((n) => {
      // Tab estilo IonTabs del Hub: icono (ionicon del manifest) + label.
      const kids = [];
      if (n.icon) kids.push(el('ion-icon', { name: n.icon }));
      kids.push(el('ion-label', { text: n.label || n.component }));
      seg.appendChild(el('ion-segment-button', { value: n.component }, kids));
    });
    footer.style.display = navs.length ? 'block' : 'none';
    if (navs.length) { seg.value = navs[0].component; showView(navs[0].component); }
    else view.innerHTML = '<div class="ion-padding tk-sub">Este módulo no tiene navegación de UI.</div>';
    renderInspector(m);
  }
  window.__openModule = openModule;

  function renderInspector(m) {
    inspList.innerHTML = '';
    const sec = (titleStr, items) => {
      inspList.appendChild(el('ion-list-header', {}, el('ion-label', { text: titleStr })));
      if (!items.length) inspList.appendChild(el('ion-item', {}, el('ion-label', { class: 'tk-mono', text: '—' })));
      for (const t of items) inspList.appendChild(el('ion-item', {}, el('ion-label', { class: 'tk-mono', text: t })));
    };
    sec('Queries', Object.keys(m.queries || {}));
    sec('Commands', Object.keys(m.commands || {}));
    sec('Permisos', m.permissions || []);
    sec('Eventos (emit)', [...new Set(Object.values(m.commands || {}).flatMap((c) => c.emit || []).map(emitName))]);
  }

  function toggleOverlay(force) {
    const open = force != null ? force : !document.body.classList.contains('tk-overlay-open');
    document.body.classList.toggle('tk-overlay-open', open);
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleOverlay(false); });

  // Arranque: módulo preseleccionado o página main.
  if (PRESELECT && MODULES.some((m) => m.id === PRESELECT)) openModule(PRESELECT);
  else openHome();
});
`;
}

const INDEX_HTML = (label) => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>erplora dev · ${label}</title>
  <link rel="stylesheet" href="/harness.css" />
  <style>
    /* Paleta Ionic por defecto (light) — sin ella ion-toggle/ion-button no tienen color (success=verde, danger=rojo…). */
    :root {
      --ion-color-primary:#3880ff; --ion-color-primary-rgb:56,128,255; --ion-color-primary-contrast:#fff; --ion-color-primary-contrast-rgb:255,255,255; --ion-color-primary-shade:#3171e0; --ion-color-primary-tint:#4c8dff;
      --ion-color-success:#2dd36f; --ion-color-success-rgb:45,211,111; --ion-color-success-contrast:#fff; --ion-color-success-contrast-rgb:255,255,255; --ion-color-success-shade:#28ba62; --ion-color-success-tint:#42d77d;
      --ion-color-warning:#ffc409; --ion-color-warning-rgb:255,196,9; --ion-color-warning-contrast:#000; --ion-color-warning-contrast-rgb:0,0,0; --ion-color-warning-shade:#e0ac08; --ion-color-warning-tint:#ffca22;
      --ion-color-danger:#eb445a; --ion-color-danger-rgb:235,68,90; --ion-color-danger-contrast:#fff; --ion-color-danger-contrast-rgb:255,255,255; --ion-color-danger-shade:#cf3c4f; --ion-color-danger-tint:#ed576b;
      --ion-color-medium:#92949c; --ion-color-medium-rgb:146,148,156; --ion-color-medium-contrast:#fff; --ion-color-medium-contrast-rgb:255,255,255; --ion-color-medium-shade:#808289; --ion-color-medium-tint:#9d9fa6;
      --ion-color-light:#f4f5f8; --ion-color-light-rgb:244,245,248; --ion-color-light-contrast:#000; --ion-color-light-contrast-rgb:0,0,0; --ion-color-light-shade:#d7d8da; --ion-color-light-tint:#f5f6f9;
      --ion-text-color:#1c1b18; --ion-text-color-rgb:28,27,24; --ion-background-color:#fff; --ion-background-color-rgb:255,255,255;
    }
    :root { --tk-bg:#faf8f2; --tk-surface:#fff; --tk-border:#e6e2d8; --tk-text:#1c1b18; --tk-muted:#6b6557; }
    html, body { margin:0; height:100%; background:var(--tk-bg); color:var(--tk-text); font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
    #app, ion-app { height:100%; display:block; }
    .tk-layout { display:flex; height:100%; }
    .tk-sidebar { width:240px; flex:0 0 240px; background:var(--tk-surface); border-right:1px solid var(--tk-border); display:flex; flex-direction:column; min-height:0; }
    .tk-brand { padding:1rem; font-weight:700; border-bottom:1px solid var(--tk-border); }
    .tk-brand-sub { font-size:11px; font-weight:500; color:var(--tk-muted); text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
    .tk-side-scroll { flex:1; overflow:auto; }
    .tk-main { flex:1; min-width:0; display:flex; flex-direction:column; }
    .tk-content { flex:1; --background:var(--tk-bg); }
    /* En vista de módulo, ion-content no scrollea: la tabla (modo fill) hace scroll interno. */
    .tk-content.tk-fixed { --overflow:hidden; }
    .tk-view-fill { height:100%; box-sizing:border-box; padding:1rem; display:flex; flex-direction:column; min-height:0; }
    .tk-view-fill > * { flex:1 1 auto; min-height:0; }
    /* Tabs inferiores = métrica de IonTabs del Hub (icono + label compactos, sin uppercase). */
    ion-footer ion-segment-button { font-size:12px; font-weight:400; letter-spacing:.03em; text-transform:none; min-height:54px; }
    ion-footer ion-segment-button ion-icon { font-size:22px; }
    .tk-h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .tk-sub { color:var(--tk-muted); margin:.25rem 0 1rem; font-size:14px; }
    .tk-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(230px,1fr)); gap:.75rem; }
    .tk-card { margin:0; cursor:pointer; }
    .tk-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
    /* Drawer derecho */
    .tk-scrim { position:fixed; inset:0; background:rgba(0,0,0,.32); opacity:0; pointer-events:none; transition:.18s; z-index:50; }
    .tk-overlay { position:fixed; top:0; right:0; height:100%; width:360px; max-width:88vw; background:var(--tk-surface); border-left:1px solid var(--tk-border); box-shadow:-8px 0 24px rgba(0,0,0,.08); transform:translateX(100%); transition:.2s; z-index:51; display:flex; flex-direction:column; }
    .tk-overlay ion-content { flex:1; }
    body.tk-overlay-open .tk-scrim { opacity:1; pointer-events:auto; }
    body.tk-overlay-open .tk-overlay { transform:translateX(0); }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/harness.js"></script>
</body>
</html>`;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };

export async function dev(moduleDir, opts = {}) {
  const port = opts.port || 4321;
  const argDir = moduleDir ? resolve(process.cwd(), moduleDir) : null;
  const single = argDir && existsSync(join(argDir, 'module.json')) ? argDir : null;
  const rootDir = single
    ? join(single, '..')
    : existsSync(join(process.cwd(), 'modules'))
      ? join(process.cwd(), 'modules')
      : process.cwd();

  const { mods, fixtures, wcFiles } = collectModules(rootDir, single);
  if (!mods.length) throw new Error(`No encontré módulos con UI en ${rootDir}`);
  const preselect = single ? JSON.parse(readFileSync(join(single, 'module.json'), 'utf8')).id : null;

  const outDir = join(tmpdir(), `erplora-dev-${preselect || 'workspace'}`);
  mkdirSync(outDir, { recursive: true });

  // Every rebuild has to be VISIBLE (module-toolkit#81). `logLevel: 'silent'` stays — the plugin
  // below prints a better report than esbuild's default and, crucially, also flips `status`, which
  // is what stops the server handing out the stale bundle as if nothing had happened.
  const status = createBuildStatus();
  let firstBuilt;
  const firstBuild = new Promise((r) => { firstBuilt = r; });

  const ctx = await esContext({
    stdin: { contents: harnessEntry(mods, fixtures, wcFiles, preselect), resolveDir: rootDir, sourcefile: 'workspace.dev.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: outDir,
    entryNames: 'harness',
    assetNames: '[name]',
    loader: { '.css': 'css', '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl' },
    tsconfigRaw: TSCONFIG_RAW,
    plugins: [erploraResolvePlugin(), buildStatusPlugin({ status, onFirstBuild: firstBuilt })],
    logLevel: 'silent',
  });
  // ONE startup build, not two. `ctx.watch()` performs its own initial build, so the `ctx.rebuild()`
  // that used to precede it was a duplicate — harmless while everything was silent, but it made the
  // preview announce `✓ recompilado` under its own banner as soon as rebuilds became visible.
  // Waiting on the watcher's build instead keeps the guarantee the explicit rebuild was there for:
  // the server never listens before there is something to serve.
  //
  // A first build that FAILS must not kill the preview either — the plugin has already printed the
  // errors, and coming up anyway is what lets the browser show them and self-heal on the next save
  // (`vite`/`ionic serve`, `shopify app dev`). Before this, the first error exited the process while
  // every later error was swallowed in silence: two opposite treatments of the same fault.
  await ctx.watch();
  await firstBuild;

  const server = createServer(async (req, res) => {
    try {
      const p = (req.url || '/').split('?')[0];
      if (p === '/') { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Security-Policy': CSP }); return res.end(INDEX_HTML(preselect || 'workspace')); }
      // The bundle on disk is the last one that COMPILED. While the build is broken, serving it is
      // the silent lie of module-toolkit#81 — hand out the error overlay instead, never a 200 with
      // stale code. `no-store` so a fixed build is not hidden behind a cached error page.
      if (servesErrorOverlay(status, p)) {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
        return res.end(overlayScript(status.errors));
      }
      const file = join(outDir, p.replace(/^\/+/, ''));
      if (!file.startsWith(outDir) || !existsSync(file)) { res.writeHead(404, { 'Content-Security-Policy': CSP }); return res.end('not found'); }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
      res.end(data);
    } catch {
      res.writeHead(500).end('error');
    }
  });

  await new Promise((r) => server.listen(port, r));
  console.log(`▶ erplora dev → http://localhost:${port}  (${mods.length} módulo(s)${preselect ? `, abre '${preselect}'` : ', página main'}; CSP estricta, watch)`);
  console.log('   Ctrl-C para salir.');

  await new Promise(() => {
    const stop = async () => { await ctx.dispose(); server.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
