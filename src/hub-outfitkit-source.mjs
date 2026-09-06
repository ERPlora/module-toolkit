// The OutfitKit a hub REALLY carries, asked to the hub — ERPlora/module-toolkit#203.
//
// **What it is for.** `validate-outfitkit-floor.mjs` decides whether a module may publish a screen
// by comparing the OutfitKit it baked against the one the hub paints with. Until now the second
// half of that comparison was `HUB_OUTFITKIT`, a table DERIVED BY DATE («the last
// `@erplora/outfitkit` published on npm before that tag was cut») that a human has to extend on
// every hub release. Because it is a guess, the control it feeds could only warn: nobody blocks a
// publish on a number worked out from timestamps. So a screen the customer's hub cannot paint is
// published anyway, and the one who finds out is the customer, days later.
//
// **What changed.** Since ERPlora/hub#1588 the hub SAYS it: the shell build emits
// `dist/outfitkit-version.json`, `docker/Dockerfile` copies it to `/app/web/outfitkit-version.json`
// and refuses to build an image without it (`OUTFITKIT_STAMP_MISSING`/`OUTFITKIT_STAMP_MISMATCH`),
// and the runtime's static layer serves it. Any live hub answers:
//
//     GET https://<slug>.erplora.com/outfitkit-version.json
//     { "outfitkit": "0.1.65", "hub": "1.1.14" }
//
// 🔴 **The SPA fallback is why the body is parsed and the status is not trusted.** The hub's static
// layer (`with_static_frontend`, `hub/crates/server/src/routes.rs`) falls back to `index.html` for
// any path with no file behind it — **200 OK**, not 404. A hub built before hub#1588 therefore
// answers this endpoint with a successful page of HTML. Believing the status code would turn «this
// hub is too old to tell me» into a parse crash on every validate; what happens instead is that the
// answer is recognised as not-a-stamp, said out loud, and the derived table keeps the job.
//
// 🔴 **Degrading is ALWAYS allowed, blocking on a degradation never is.** No network, no hub
// configured, an old hub, a broken answer: all of them fall back to the derived table, which is
// exactly today's behaviour. A gate that stops everybody the day the VPN hiccups is a gate that
// gets switched off, not obeyed — the same lesson as the ratchet in `validate-outfitkit-floor.mjs`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Where the hub publishes the pair. Fixed by `hub/docker/Dockerfile` + the static layer. */
export const HUB_STAMP_PATH = '/outfitkit-version.json';

/** Which hub to ask. Opt-in: unset means «no real source», which is a degradation, not a fault. */
export const HUB_URL_ENV = 'ERPLORA_HUB_URL';

/** Where the last real reading is remembered. Overridable so tests never touch a real `~`. */
export const CACHE_ENV = 'ERPLORA_HUB_OUTFITKIT_CACHE';

/** How long a hub gets to answer. Short on purpose: this runs inside every `erplora validate`. */
export const FETCH_TIMEOUT_MS = 4000;

/** `1.1.14`, `0.1.66-rc.1`. Anything else (`latest`, `stable`, a number) is not a version. */
const VERSION_RE = /^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

const isVersion = (v) => typeof v === 'string' && VERSION_RE.test(v);

/** The cache file: `~/.erplora/hub-outfitkit.json` unless the environment says otherwise. */
export function cacheFile(env = process.env) {
  return env[CACHE_ENV] || join(homedir(), '.erplora', 'hub-outfitkit.json');
}

/**
 * The pair, or `null` — and `null` covers every «that was not an answer» at once.
 *
 * Both halves are required. An `outfitkit` with no `hub` cannot resolve a declared floor, and a
 * `hub` with no `outfitkit` answers nothing; half a stamp is worse than none, because it looks like
 * a fact. Values are type-checked AND shape-checked: `{"outfitkit": 165}` would otherwise reach
 * `compareOutfitkitVersions`, which reads it as `[165]` and makes it newer than everything ever
 * published — a typo in someone else's artifact turning into a hard block on ours.
 */
export function parseHubStamp(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Solo el nulo necesita rama propia, porque leerle una propiedad revienta. Un array, un objeto
  // vacío, un número o una cadena NO: `[].outfitkit`, `(165).outfitkit` y `'x'.outfitkit` son
  // `undefined`, y las dos comprobaciones de versión de abajo los rechazan igual. Aquí había además
  // un `typeof parsed !== 'object' || Array.isArray(parsed)`; los mutantes del 2026-09-06 (M2, M2b)
  // lo borraron entero SIN romper un solo caso — era código que aparentaba vigilar. Un guardia
  // inalcanzable no es defensa en profundidad: es una línea que el siguiente lector cree probada.
  if (!parsed) return null;
  if (!isVersion(parsed.outfitkit) || !isVersion(parsed.hub)) return null;
  return { hub: parsed.hub, outfitkit: parsed.outfitkit };
}

/** The last real reading, or `null`. Goes through the same parser as the wire, on purpose. */
function readCache(file) {
  if (!existsSync(file)) return null;
  try {
    return parseHubStamp(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remembers a real reading so the next offline run is not back to guessing by date.
 *
 * Failing to write is not worth a word: a read-only or absent `~` must not redden a validate, and
 * the only thing lost is the offline path of the NEXT run, which degrades exactly like today.
 */
function writeCache(file, row, url) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ ...row, url, read_at: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    /* the reading still stands for this run; the cache is an optimisation, not the source */
  }
}

/**
 * Asks the configured hub what OutfitKit it carries.
 *
 * Returns `{ row, warnings }`. `row` is `null` when there is no real source — the caller then keeps
 * using the derived table, which is what it did before this existed. `warnings` is empty when
 * nothing is configured (opt-in, and a warning on every module PR is a warning nobody reads) and
 * carries exactly one line when a source WAS configured and could not be used: a degradation that
 * prints nothing is how a control quietly stops controlling.
 *
 * Never throws. Every failure of the network, of the hub or of the answer is a warning.
 */
export async function readHubOutfitkit({ env = process.env, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const file = cacheFile(env);
  const url = (env[HUB_URL_ENV] || '').trim().replace(/\/+$/, '');
  const cached = readCache(file);

  if (!url) {
    return { row: cached ? { ...cached, origin: 'cache' } : null, warnings: [] };
  }

  const endpoint = `${url}${HUB_STAMP_PATH}`;
  let reason = null;
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      reason = `respondió HTTP ${res.status}`;
    } else {
      const row = parseHubStamp(await res.text());
      if (row) {
        writeCache(file, row, url);
        return { row: { ...row, origin: 'live', url }, warnings: [] };
      }
      reason =
        'contestó algo que no es el sello `{ outfitkit, hub }` (un hub anterior a ERPlora/hub#1588 ' +
        'no lo publica, y su capa estática devuelve `index.html` con 200 en vez de un 404)';
    }
  } catch (err) {
    reason = `no respondió en ${timeoutMs} ms o no se pudo alcanzar (${err?.message ?? err})`;
  }

  const head = `no se pudo leer el OutfitKit real de ${endpoint}: ${reason}`;
  if (cached) {
    return {
      row: { ...cached, origin: 'cache' },
      warnings: [
        `${head}. Se usa la última lectura CACHEADA (hub ${cached.hub} → OutfitKit ` +
          `${cached.outfitkit}, ${file}), que puede haberse quedado atrás.`,
      ],
    };
  }
  return {
    row: null,
    warnings: [
      `${head}. Se sigue con la tabla derivada por fecha \`HUB_OUTFITKIT\`, así que el suelo de ` +
        'OutfitKit se comprueba contra un número DEDUCIDO: el control avisa, no bloquea.',
    ],
  };
}
