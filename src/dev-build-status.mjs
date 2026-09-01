// Makes a failed rebuild of `erplora dev` VISIBLE — module-toolkit#81.
//
// The preview used to create its esbuild context with `logLevel: 'silent'` and no `onEnd` hook, so
// a syntax or type error in a Web Component produced nothing at all: no terminal line, no overlay,
// no console error, while the HTTP server kept serving the last GOOD bundle with a 200. The only
// symptom was an edit that appeared to do nothing, which reads as a broken watcher rather than a
// broken file. The standard this restores is Vite (`ionic serve`) and `shopify app dev`: the error
// reaches the terminal the moment it happens, the browser gets an overlay, and neither of them ever
// keeps serving the stale build in silence.
//
// This module is deliberately dependency-free — no esbuild import — for one reason: CI cannot
// install esbuild (three of this package's dependencies are `file:` paths into sibling checkouts
// that do not exist on a runner), so anything importing `src/dev.mjs` is a local-only suite. The
// decisions worth guarding live here instead, where `test/dev-build-status.test.mjs` runs on every
// pull request. An esbuild plugin is a plain object, so the rebuild wiring is covered too.
//
// CLI output is Spanish, matching every other command in this toolkit (`✓ build`, `✓ pack`,
// `Ctrl-C para salir`); identifiers and comments are English, per the monorepo rule.

/** Terminal styling, dropped when stdout is not a TTY so logs stay greppable. */
const useColor = () => Boolean(process.stdout && process.stdout.isTTY);
const red = (s) => (useColor() ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (useColor() ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s) => (useColor() ? `\x1b[2m${s}\x1b[0m` : s);

/**
 * One esbuild message as esbuild itself would print it: `file:line:column: ERROR: text`.
 * Plugin errors (`erploraResolvePlugin`) carry no `location`, so the prefix is simply omitted —
 * never rendered as `undefined:undefined`.
 */
export function formatMessage(message) {
  const { text = '', location } = message || {};
  const where = location && location.file ? `${location.file}:${location.line ?? 0}:${location.column ?? 0}: ` : '';
  return `${where}ERROR: ${text}`;
}

/**
 * The block printed the instant a rebuild fails. It names every error and — the half the developer
 * was missing — says out loud that what the browser shows is now stale.
 */
export function terminalReport(errors = [], warnings = []) {
  const n = errors.length;
  const head = red(`✗ erplora dev — la compilación falló (${n} ${n === 1 ? 'error' : 'errores'}). El preview NO se ha actualizado.`);
  const body = errors.map((e) => `  ${formatMessage(e)}`);
  const warn = warnings.map((w) => dim(`  AVISO: ${formatMessage(w).replace(/^ERROR: /, '')}`));
  return [head, ...body, ...warn, dim('  Arregla el fichero y guarda: el watch recompila solo.')].join('\n');
}

/** The confirmation that did not exist either: a clean rebuild said nothing at all. */
export function rebuiltLine(wasFailed = false) {
  return green(
    wasFailed
      ? '✓ erplora dev — recompilado sin errores. Recarga la página.'
      : '✓ erplora dev — recompilado.',
  );
}

/**
 * Whether the bundle currently on disk is trustworthy. `failed` is the whole point: while it is
 * true, `outDir` still holds the last good `harness.js`, and serving it is exactly the silent lie
 * this issue is about.
 */
export function createBuildStatus() {
  let failure = null;
  return {
    get failed() {
      return failure !== null;
    },
    get errors() {
      return failure ? failure.slice() : [];
    },
    fail(errors) {
      failure = errors && errors.length ? errors.slice() : [{ text: 'la compilación falló sin detalle' }];
    },
    pass() {
      failure = null;
    },
  };
}

/**
 * esbuild plugin that turns every rebuild into a visible outcome. A plugin is a plain object, which
 * is why this can be driven — and tested — without esbuild being installed.
 *
 * The first build is intentionally silent about SUCCESS: `dev()` prints the `▶ erplora dev → …`
 * banner right after it, and a `✓` on top of that banner is noise. Every rebuild after it speaks.
 * Failures always speak, the first one included.
 *
 * `onFirstBuild` fires exactly once, whatever the outcome — it is how `dev()` knows a bundle (or a
 * definitive failure) exists before it starts listening, so a broken module cannot hang the CLI.
 */
export function buildStatusPlugin({ status, log = console.log, onFirstBuild = () => {} }) {
  let seenFirst = false;
  return {
    name: 'erplora-dev-build-status',
    setup(build) {
      build.onEnd((result) => {
        const errors = (result && result.errors) || [];
        const warnings = (result && result.warnings) || [];
        const isFirst = !seenFirst;
        seenFirst = true;

        if (errors.length) {
          status.fail(errors);
          log(terminalReport(errors, warnings));
        } else {
          const wasFailed = status.failed;
          status.pass();
          if (!isFirst) log(rebuiltLine(wasFailed));
        }
        if (isFirst) onFirstBuild();
      });
    },
  };
}

/**
 * While the build is broken, `/harness.js` is answered with the error overlay instead of the stale
 * bundle. Only the entry module is replaced — assets (`/harness.css`, fonts, icons) keep being
 * served as they are, so the page still has its styling under the overlay.
 */
export function servesErrorOverlay(status, pathname) {
  return Boolean(status && status.failed) && pathname === '/harness.js';
}

const OVERLAY_TITLE = 'erplora dev · la compilación falló';
const OVERLAY_HINT = 'El preview está congelado en la última versión que compiló. Arregla el fichero, guarda y recarga.';

const HOST_STYLE = [
  'position:fixed', 'inset:0', 'z-index:2147483647', 'overflow:auto',
  'background:#1c1b18', 'color:#f4f5f8', 'padding:2rem',
  'font-family:ui-monospace,SFMono-Regular,Menlo,monospace', 'font-size:13px', 'line-height:1.6',
].join(';');
const TITLE_STYLE = ['margin:0 0 1rem', 'font-size:15px', 'font-weight:700', 'color:#eb445a'].join(';');
const PRE_STYLE = [
  'margin:0 0 .75rem', 'padding:.75rem 1rem', 'background:#000', 'border-left:3px solid #eb445a',
  'border-radius:4px', 'white-space:pre-wrap', 'word-break:break-word', 'font:inherit',
].join(';');
const HINT_STYLE = ['margin-top:1rem', 'color:#92949c'].join(';');

/**
 * The module served in place of the bundle while the build is broken: a full-screen overlay listing
 * the real errors, in the style of Vite's.
 *
 * CSP-safe by construction — the preview runs under `default-src 'none'; script-src 'self'`, so the
 * overlay is a served module (no inline script, no eval) that only touches the DOM (no fetch, no
 * websocket). Every error is written with `textContent`, never `innerHTML`: the text is a slice of
 * the developer's own source and routinely contains `<`, quotes and backticks, which innerHTML
 * would execute instead of showing.
 */
export function overlayScript(errors = []) {
  const lines = errors.map(formatMessage);
  return `// erplora dev — generado porque la última compilación falló (module-toolkit#81).
(function () {
  var LINES = ${JSON.stringify(lines)};
  console.error(${JSON.stringify(OVERLAY_TITLE)} + '\\n' + LINES.join('\\n'));
  function paint() {
    var old = document.getElementById('erplora-dev-error');
    if (old && old.remove) old.remove();
    var host = document.createElement('div');
    host.id = 'erplora-dev-error';
    host.setAttribute('style', ${JSON.stringify(HOST_STYLE)});
    var title = document.createElement('div');
    title.setAttribute('style', ${JSON.stringify(TITLE_STYLE)});
    title.textContent = ${JSON.stringify(OVERLAY_TITLE)};
    host.appendChild(title);
    for (var i = 0; i < LINES.length; i++) {
      var pre = document.createElement('pre');
      pre.setAttribute('style', ${JSON.stringify(PRE_STYLE)});
      pre.textContent = LINES[i];
      host.appendChild(pre);
    }
    var hint = document.createElement('div');
    hint.setAttribute('style', ${JSON.stringify(HINT_STYLE)});
    hint.textContent = ${JSON.stringify(OVERLAY_HINT)};
    host.appendChild(hint);
    document.body.appendChild(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
})();
`;
}
