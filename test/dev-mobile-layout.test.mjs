// `erplora dev` lets a developer see their module at phone and tablet size — module-toolkit#434.
//
// The preview's sidebar was a fixed 240 px column with no breakpoint, so at 375 px the module was
// left a ~135 px strip: labels broken letter by letter, tabs cut off. The hub folds its menu below
// `lg` (App.vue: `<ion-split-pane when="lg">`, 992 px); the preview now does the same — the sidebar
// becomes a drawer behind a menu button and the module takes the whole width.
//
// No browser runs in this repository's CI, so two halves: the stylesheet the server hands out is
// read rule by rule, and the harness's REAL shell code is run against a tiny fake DOM to click the
// menu button, the scrim, a sidebar entry and Escape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INDEX_HTML, harnessEntry } from '../src/dev.mjs';

// ── The stylesheet ──────────────────────────────────────────────────────────────────────────────

const css = INDEX_HTML('demo').match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');

/** `{ selector → declarations }` of a block of flat rules (no nesting). */
function rules(block) {
  const out = {};
  for (const [, sel, body] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const s of sel.split(',')) out[s.trim().replace(/\s+/g, ' ')] = (out[s.trim().replace(/\s+/g, ' ')] || '') + body.replace(/\s+/g, '');
  }
  return out;
}

/** The body of the `@media (max-width: …)` block, plus its breakpoint in px. */
function mobileBlock() {
  const at = css.search(/@media\s*\(\s*max-width\s*:/);
  assert.ok(at >= 0, 'the preview stylesheet has no max-width breakpoint: the sidebar never folds');
  const open = css.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}' && --depth === 0) break;
  }
  const px = Number(css.slice(at, open).match(/max-width\s*:\s*([\d.]+)px/)[1]);
  return { px, body: css.slice(open + 1, end), outside: css.slice(0, at) + css.slice(end + 1) };
}

test('the sidebar folds below the hub split-pane breakpoint (lg): tablet 820 and phone 375 fold, desktop 1440 does not', () => {
  const { px } = mobileBlock();
  assert.ok(px >= 820 && px < 992, `max-width ${px}px — the hub folds its menu below 992 px`);
});

test('below the breakpoint the sidebar leaves the flow and hides off-canvas until the menu opens it', () => {
  const r = rules(mobileBlock().body);
  const side = r['.tk-sidebar'] || '';
  assert.match(side, /position:fixed/, side);
  assert.match(side, /transform:translateX\(-100%\)/, side);
  assert.match(r['body.tk-menu-open .tk-sidebar'] || '', /transform:translateX\(0\)/);
  const scrim = r['body.tk-menu-open .tk-scrim'] || '';
  assert.match(scrim, /opacity:1/, scrim);
  assert.match(scrim, /pointer-events:auto/, scrim);
  assert.doesNotMatch(r['.tk-menu-btn'] || 'display:none', /display:none/, 'the menu button shows on phone and tablet');
});

test('the folded drawer is hidden for real: no shadow bleeding in from the left edge, no Tab stops in it', () => {
  const r = rules(mobileBlock().body);
  const side = r['.tk-sidebar'] || '';
  const open = r['body.tk-menu-open .tk-sidebar'] || '';
  assert.match(side, /visibility:hidden/, side);
  assert.doesNotMatch(side, /box-shadow/, 'an off-canvas box-shadow paints a grey band over the module');
  assert.match(open, /visibility:visible/, open);
  assert.match(open, /box-shadow:/, open);
});

test('the open drawer sits above the scrim, spans the full height and leaves a strip of scrim to tap', () => {
  const zIndex = (decl) => Number((decl.match(/z-index:(-?\d+)/) || [])[1]);
  const side = rules(mobileBlock().body)['.tk-sidebar'] || '';
  const scrim = rules(mobileBlock().outside)['.tk-scrim'] || '';
  // Both are position:fixed; without a higher z-index the scrim paints over the drawer and swallows its clicks.
  assert.ok(zIndex(side) > zIndex(scrim), `drawer z-index ${zIndex(side)} vs scrim ${zIndex(scrim)}`);
  assert.match(side, /height:100%/, side);
  assert.match(side, /max-width:\d+vw/, side);
});

test('on desktop the sidebar keeps its column and the menu button stays hidden', () => {
  const r = rules(mobileBlock().outside);
  assert.match(r['.tk-sidebar'] || '', /flex:00240px/);
  assert.match(r['.tk-menu-btn'] || '', /display:none/);
  // Opening the menu means nothing outside the breakpoint: on a desktop the drawer rules must not leak.
  assert.equal(r['body.tk-menu-open .tk-sidebar'], undefined);
  assert.equal(r['body.tk-menu-open .tk-scrim'], undefined);
});

// ── The harness shell against a fake DOM ────────────────────────────────────────────────────────

class ClassList {
  constructor(node) { this.node = node; }
  get set() { return new Set(this.node.className.split(/\s+/).filter(Boolean)); }
  write(s) { this.node.className = [...s].join(' '); }
  add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.write(s); }
  remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.write(s); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.style = {};
    this.textContent = '';
    this.classList = new ClassList(this);
  }
  set innerHTML(_) { this.children = []; }
  get innerHTML() { return ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  dispatch(type, ev = {}) { for (const cb of this.listeners[type] || []) cb({ type, ...ev }); }
  click() { this.dispatch('click'); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeNode) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  text() { return [...this.walk()].map((n) => n.textContent).join(''); }
}

function bootHarness() {
  const MODULES = [{ id: 'demo', name: 'Demo', navigation: [{ component: 'erp-demo', label: 'Demo' }] }];
  const src = harnessEntry(MODULES, {}, [], null)
    .split('\n')
    .filter((l) => !/^import\s/.test(l) && !/^\[i\d/.test(l))
    .join('\n');
  const body = new FakeNode('body');
  const app = new FakeNode('div');
  const winListeners = {};
  const document = {
    body,
    getElementById: (id) => (id === 'app' ? app : null),
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => Object.assign(new FakeNode('#text'), { textContent: t }),
  };
  const window = {
    addEventListener: (type, cb) => (winListeners[type] ||= []).push(cb),
  };
  const ctx = { document, window, initialize() {}, addIcons() {}, __ICONS: {}, console, Intl, globalThis: {} };
  vm.runInNewContext(src, ctx);
  for (const cb of winListeners.DOMContentLoaded || []) cb();
  const fire = (type, ev) => { for (const cb of winListeners[type] || []) cb(ev); };
  const sidebar = app.find((n) => n.tagName === 'aside' && n.classList.contains('tk-sidebar'));
  const entry = (label) => sidebar.find((n) => n.tagName === 'ion-item' && n.text() === label);
  return {
    body,
    fire,
    menuBtn: app.find((n) => n.classList.contains('tk-menu-btn')),
    scrim: app.find((n) => n.classList.contains('tk-scrim')),
    header: app.find((n) => n.tagName === 'ion-header'),
    entry,
    title: app.find((n) => n.tagName === 'ion-title'),
  };
}

test('the harness boots in the fake DOM (positive control: it finds the shell it drives)', () => {
  const h = bootHarness();
  assert.ok(h.scrim, 'no scrim');
  assert.ok(h.entry('Demo'), 'no sidebar entry for the module');
  assert.equal(h.body.classList.contains('tk-menu-open'), false);
});

test('the header carries a menu button at the start that opens and closes the sidebar drawer', () => {
  const h = bootHarness();
  assert.ok(h.menuBtn, 'no menu button in the preview header');
  const start = h.header.find((n) => n.tagName === 'ion-buttons' && n.getAttribute('slot') === 'start');
  assert.ok(start && start.find((n) => n === h.menuBtn), 'the menu button sits at the start of the toolbar, like the hub');
  assert.ok(h.menuBtn.find((n) => n.tagName === 'ion-icon' && n.getAttribute('name') === 'menu-outline'));
  assert.ok(h.menuBtn.getAttribute('aria-label'), 'an icon-only button needs an accessible name');
  h.menuBtn.click();
  assert.equal(h.body.classList.contains('tk-menu-open'), true);
  h.menuBtn.click();
  assert.equal(h.body.classList.contains('tk-menu-open'), false);
});

test('picking a module in the drawer opens it AND closes the drawer, so the module is in view', () => {
  const h = bootHarness();
  h.menuBtn.click();
  h.entry('Demo').click();
  assert.equal(h.title.textContent, 'Demo');
  assert.equal(h.body.classList.contains('tk-menu-open'), false);
  h.menuBtn.click();
  h.entry('Inicio').click();
  assert.equal(h.title.textContent, 'Inicio');
  assert.equal(h.body.classList.contains('tk-menu-open'), false);
});

test('closing is closing, never a toggle: Escape, the scrim or a desktop sidebar click leave a closed drawer closed', () => {
  const h = bootHarness();
  h.fire('keydown', { key: 'Escape' });
  assert.equal(h.body.classList.contains('tk-menu-open'), false, 'Escape opened the drawer');
  h.scrim.click();
  assert.equal(h.body.classList.contains('tk-menu-open'), false, 'the scrim opened the drawer');
  // On desktop the sidebar is a column and nobody opened a drawer: shrinking the window later must
  // not reveal one that a click left "open".
  h.entry('Demo').click();
  assert.equal(h.body.classList.contains('tk-menu-open'), false, 'a sidebar click opened the drawer');
});

test('the shared scrim still closes the inspector drawer', () => {
  const h = bootHarness();
  const end = h.header.find((n) => n.tagName === 'ion-buttons' && n.getAttribute('slot') === 'end');
  end.find((n) => n.tagName === 'ion-button').click();
  assert.equal(h.body.classList.contains('tk-overlay-open'), true, 'the inspector button did not open the inspector');
  h.scrim.click();
  assert.equal(h.body.classList.contains('tk-overlay-open'), false);
});

test('the scrim and Escape close the drawer', () => {
  const h = bootHarness();
  h.menuBtn.click();
  h.scrim.click();
  assert.equal(h.body.classList.contains('tk-menu-open'), false);
  h.menuBtn.click();
  h.fire('keydown', { key: 'Escape' });
  assert.equal(h.body.classList.contains('tk-menu-open'), false);
});
