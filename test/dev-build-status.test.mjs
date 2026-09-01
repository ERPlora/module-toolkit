// A failed rebuild of `erplora dev` has to be VISIBLE — module-toolkit#81. `node --test`.
//
// The bug this suite exists for: the preview created its esbuild context with `logLevel: 'silent'`
// and no `onEnd` hook, so a syntax/type error in a Web Component produced NOTHING — not a line in
// the terminal, not an overlay, not a console error — while `createServer` happily kept serving the
// last GOOD bundle out of `outDir` with a 200. Reproduced on origin/main@7ed661b: after appending
// `this is not valid typescript (((` to a component, the dev log still held only its two startup
// lines and `curl /harness.js` still returned the previous marker. The developer's only signal was
// that their edit "did nothing", which reads as a broken watcher, not as a broken file.
//
// The standard is Vite (`ionic serve`) and `shopify app dev`: the error lands in the terminal the
// moment it happens, the browser gets an overlay, and neither of them ever keeps serving the stale
// build in silence.
//
// WHY THIS UNIT IS SEPARATE FROM `src/dev.mjs`: dev.mjs imports esbuild, and CI cannot install it
// (three dependencies are `file:` paths into sibling checkouts that do not exist on a runner), so
// every suite that touches dev.mjs is a local-only `node --test`. A guard nobody runs is the defect
// this repository keeps finding in other people's code, so the decisions worth guarding — what gets
// printed, what the browser is handed, and when the preview is considered stale — live in a
// dependency-free module that CI does run. An esbuild plugin is a plain object, so even the
// rebuild wiring is exercised here without esbuild being present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  formatMessage,
  terminalReport,
  createBuildStatus,
  buildStatusPlugin,
  servesErrorOverlay,
  overlayScript,
} from '../src/dev-build-status.mjs';

/** An esbuild message, shaped the way esbuild really emits it. */
const message = (over = {}) => ({
  text: 'Expected ";" but found "is"',
  location: { file: 'ui/components/erp-demo/erp-demo.ts', line: 8, column: 5 },
  ...over,
});

// ── What the terminal gets ────────────────────────────────────────────────────────────────────

test('formatMessage places the error where esbuild places it: file:line:column', () => {
  const line = formatMessage(message());
  assert.match(line, /ui\/components\/erp-demo\/erp-demo\.ts:8:5/);
  assert.match(line, /Expected ";" but found "is"/);
});

test('formatMessage survives a message with no location (plugin errors carry none)', () => {
  const line = formatMessage({ text: "No pude resolver 'lit' desde el toolkit." });
  assert.match(line, /No pude resolver 'lit' desde el toolkit\./);
  assert.doesNotMatch(line, /undefined/);
});

test('terminalReport names every error and says the preview did NOT update', () => {
  const report = terminalReport([
    message(),
    message({ text: 'Could not resolve "./missing"', location: { file: 'a.ts', line: 2, column: 0 } }),
  ]);
  assert.match(report, /erp-demo\.ts:8:5/);
  assert.match(report, /a\.ts:2:0/);
  assert.match(report, /Could not resolve "\.\/missing"/);
  // The half the developer was missing: that what the browser shows is now stale.
  assert.match(report, /preview/i);
  assert.match(report, /2/, 'the error count belongs in the header');
});

// ── The state machine that decides "stale" ────────────────────────────────────────────────────

test('a fresh status is clean, a failed rebuild marks it, a good one clears it', () => {
  const status = createBuildStatus();
  assert.equal(status.failed, false);

  status.fail([message()]);
  assert.equal(status.failed, true);
  assert.equal(status.errors.length, 1);

  status.pass();
  assert.equal(status.failed, false);
  assert.deepEqual(status.errors, []);
});

// ── The rebuild wiring (an esbuild plugin is a plain object: no esbuild needed) ────────────────

/** Captures the `onEnd` callback the plugin registers, so it can be driven by hand. */
function drive(plugin) {
  let onEnd;
  plugin.setup({ onEnd: (cb) => { onEnd = cb; } });
  assert.equal(typeof onEnd, 'function', 'the plugin must register an onEnd hook');
  return onEnd;
}

test('a rebuild that fails marks the status AND prints the errors immediately', async () => {
  const status = createBuildStatus();
  const printed = [];
  const onEnd = drive(buildStatusPlugin({ status, log: (s) => printed.push(s) }));

  await onEnd({ errors: [], warnings: [] }); // the initial build, which succeeded
  await onEnd({ errors: [message()], warnings: [] });

  assert.equal(status.failed, true);
  assert.equal(printed.length, 1, 'exactly one report, at the moment it broke');
  assert.match(printed[0], /erp-demo\.ts:8:5/);
});

test('recompiling cleanly confirms it — the ✓ line that did not exist either', async () => {
  const status = createBuildStatus();
  const printed = [];
  const onEnd = drive(buildStatusPlugin({ status, log: (s) => printed.push(s) }));

  await onEnd({ errors: [], warnings: [] }); // initial build
  await onEnd({ errors: [message()], warnings: [] }); // broken
  await onEnd({ errors: [], warnings: [] }); // fixed

  assert.equal(status.failed, false);
  assert.equal(printed.length, 2);
  assert.match(printed[1], /✓/);
});

test('the FIRST build stays silent: the startup banner is what announces it', async () => {
  const status = createBuildStatus();
  const printed = [];
  const onEnd = drive(buildStatusPlugin({ status, log: (s) => printed.push(s) }));

  await onEnd({ errors: [], warnings: [] });

  assert.deepEqual(printed, [], 'no ✓ before `▶ erplora dev →` has even been printed');
});

// Found by running the real thing, which is why it is here: the first version of this fix printed
// a stray `✓ erplora dev — recompilado.` at startup, under the banner. The cause was NOT the
// counter below but dev.mjs building TWICE — `ctx.rebuild()` and then `ctx.watch()`, which does its
// own initial build. Counting "the first" is only honest if there IS one startup build, so dev.mjs
// now drops the explicit rebuild and waits for the watcher's, and this is the signal it waits on.
// Timing cannot stand in for it: in the observed run the second build finished AFTER the banner had
// already been printed, so any "are we live yet?" flag would have let the stray line through.
test('onFirstBuild fires once, so dev() can wait for a bundle before it listens', async () => {
  const status = createBuildStatus();
  const fired = [];
  const onEnd = drive(
    buildStatusPlugin({ status, log: () => {}, onFirstBuild: () => fired.push(Date.now()) }),
  );

  await onEnd({ errors: [], warnings: [] });
  await onEnd({ errors: [], warnings: [] });
  await onEnd({ errors: [message()], warnings: [] });

  assert.equal(fired.length, 1, 'exactly once, on the first build');
});

test('onFirstBuild fires even when that first build FAILED (the server still comes up)', async () => {
  const status = createBuildStatus();
  let fired = 0;
  const onEnd = drive(buildStatusPlugin({ status, log: () => {}, onFirstBuild: () => { fired += 1; } }));

  await onEnd({ errors: [message()], warnings: [] });

  assert.equal(fired, 1, 'a broken module must not hang `erplora dev` forever');
  assert.equal(status.failed, true);
});

// ── What the browser is handed ────────────────────────────────────────────────────────────────

test('while the build is broken the harness serves the overlay, never the stale bundle', () => {
  const status = createBuildStatus();
  assert.equal(servesErrorOverlay(status, '/harness.js'), false);

  status.fail([message()]);
  assert.equal(servesErrorOverlay(status, '/harness.js'), true);
  // Only the entry module is replaced; assets keep being served as they are.
  assert.equal(servesErrorOverlay(status, '/harness.css'), false);

  status.pass();
  assert.equal(servesErrorOverlay(status, '/harness.js'), false);
});

/** The smallest DOM the overlay needs, so the generated source can be RUN rather than described. */
function fakeDom(readyState = 'complete') {
  const node = (tagName) => ({
    tagName,
    children: [],
    textContent: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
  });
  const body = node('body');
  const listeners = {};
  return {
    body,
    listeners,
    document: {
      readyState,
      body,
      createElement: node,
      getElementById: () => null,
      addEventListener: (ev, cb) => { (listeners[ev] ||= []).push(cb); },
    },
  };
}

/** Every piece of text the overlay put on the page. */
function textOf(n) {
  return [n.textContent || '', ...n.children.map(textOf)].join('\n');
}

function paint(errors, readyState = 'complete') {
  const dom = fakeDom(readyState);
  const sandbox = { document: dom.document, console: { error: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(overlayScript(errors), sandbox, { filename: 'harness-error-overlay.js' });
  return dom;
}

test('the overlay puts the real error on the page, not a generic "something failed"', () => {
  const dom = paint([message()]);
  assert.equal(dom.body.children.length, 1, 'exactly one overlay host');

  const text = textOf(dom.body.children[0]);
  assert.match(text, /erp-demo\.ts:8:5/);
  assert.match(text, /Expected ";" but found "is"/);
});

test('the overlay waits for the document when the script runs before the body exists', () => {
  const dom = paint([message()], 'loading');
  assert.equal(dom.body.children.length, 0, 'nothing painted yet');
  assert.equal(dom.listeners.DOMContentLoaded.length, 1);

  dom.listeners.DOMContentLoaded[0]();
  assert.equal(dom.body.children.length, 1);
});

test('an error text full of markup cannot inject HTML into the preview', () => {
  // Error text is a slice of the developer's own source: it routinely contains `<`, quotes and
  // backticks. Anything built with innerHTML would execute it instead of showing it.
  const nasty = '</div><img src=x onerror="globalThis.PWNED=1">';
  const dom = paint([{ text: nasty, location: { file: 'x.ts', line: 1, column: 0 } }]);

  const overlay = dom.body.children[0];
  assert.match(textOf(overlay), /onerror/, 'the text is SHOWN…');
  const html = JSON.stringify(overlay);
  assert.ok(!/innerHTML/.test(overlayScript([])), '…and never assigned through innerHTML');
  assert.ok(html.includes('onerror'), 'it lives in textContent, where it is inert');
});
