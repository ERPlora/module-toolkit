// Where the mirrors look for ERPlora/hub, WHAT they read there, and what happens when it is not
// there (module-toolkit#61, #90).
//
// A guard that skips does not deny: it stays OPEN. The six mirrors of
// `canonical-mirrors.test.mjs` each opened with `if (!existsSync(x)) return t.skip(...)`, so a run
// with no hub reported `pass 0 · fail 0 · skipped 7` and the job went green — the same shape a
// PASS has in a summary nobody reads twice.
//
// THE DISTINCTION THIS FILE MAKES. "There is no hub" and "the hub you NAMED is not there" are not
// the same fact:
//
//   * Nobody declared one → an honest skip, but only after trying the sibling checkout (below).
//
//   * `ERPLORA_HUB_DIR` was set and the file is not under it → an ERROR. The promise "compare
//     against THIS hub" was accepted and then quietly dropped, which is worse than never making
//     it: a typo in the path, or a checkout that has since moved, switches all six mirrors off and
//     the summary still says green. It happened for real — a worker ran the suite from a worktree,
//     reported "full suite green, canonical-mirrors included", and none of them had run.
//
// AND WHAT IT READS (module-toolkit#90). The sibling `../hub` checkout is read at a REF —
// `origin/develop` — never on disk. Read from disk it is whatever branch a colleague left it on,
// with whatever is uncommitted in it, and the mirrors then fail over somebody else's work in
// progress: measured on 2026-08-28, `schemas/module.schema.json` was byte-identical to hub
// `origin/develop` and the mirror failed anyway, because the neighbouring checkout sat on
// `fix/blueprint-media-auth`. Three workers in a row filed it as "pre-existing failure on main,
// not mine". A guard that cries wolf gets muted, and then it is not a guard.
//
// The DECLARED hub keeps reading disk, on purpose: the callers that declare one are CI jobs
// (`.github/actions/check-canonical-mirrors` from the hub, and this repository's own `ci.yml`
// since #90), and there the checkout on disk IS the thing under test.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The stable reference of the hub. Not a branch anyone works on — the integration branch. */
export const HUB_REF = 'origin/develop';

/** The remote a source with no ref of its own is asked. Every hub checkout has one; CI clones it. */
const DEFAULT_REMOTE = 'origin';

/**
 * Where the mirrors get the hub, and how. Three sources, in strict order of preference:
 *
 *   - `{ kind: 'declared', dir }` — `ERPLORA_HUB_DIR`, read from disk. Missing file => error.
 *   - `{ kind: 'git', dir, ref }` — the sibling `../hub` checkout, read at `origin/develop`
 *     through git. Its working tree is never touched. Missing file in the ref => error.
 *   - `{ kind: 'absent', dir }` — nothing to compare against => honest skip.
 */
export function hubSource(env = process.env) {
  if (env.ERPLORA_HUB_DIR) return { kind: 'declared', dir: env.ERPLORA_HUB_DIR };
  const sibling = join(TOOLKIT, '..', 'hub');
  if (existsSync(join(sibling, '.git')) && refExists(sibling, HUB_REF)) {
    return { kind: 'git', dir: sibling, ref: HUB_REF };
  }
  return { kind: 'absent', dir: sibling };
}

/**
 * The hub checkout to compare against, and whether it was DECLARED (`ERPLORA_HUB_DIR`) or merely
 * guessed as the sibling of this repository. Kept as the narrow answer to "which directory";
 * `hubSource` is the one that also says HOW it is read.
 */
export function hubDir(env = process.env) {
  const source = hubSource(env);
  return { dir: source.dir, declared: source.kind === 'declared' };
}

/**
 * A file (or directory) of the hub, on disk and ready to `readFileSync`/`readdirSync`, or `null`
 * after skipping the test when there is no hub to compare against. Throws when a hub that WAS
 * available cannot produce the path — a declared hub missing the file, or a ref that does not
 * carry it.
 *
 * @param {{skip: (reason: string) => void}} t the test context
 * @param {...string} segments path inside the hub, then optionally a source (see `hubSource`)
 */
export function hubPath(t, ...segments) {
  const last = segments.at(-1);
  const given = typeof last === 'object' && last !== null ? segments.pop() : {};
  const source = asSource(given);

  if (source.kind === 'git') return join(exportedTree(source, segments), ...segments);

  const full = join(source.dir, ...segments);
  if (existsSync(full)) return full;

  if (source.kind === 'declared') {
    throw new Error(
      `ERPLORA_HUB_DIR points at \`${source.dir}\`, and \`${segments.join('/')}\` is not under it. ` +
        'A declared hub that cannot be read is an error, never a skip: leaving it as a skip is how ' +
        'six mirrors switch themselves off while the run still reports green (module-toolkit#61). ' +
        'Fix the path, or unset ERPLORA_HUB_DIR to say honestly that there is no hub to compare with.',
    );
  }

  t.skip(
    `ERPlora/hub is not in this checkout (looked in \`${source.dir}\`, and it carries no ` +
      `\`${HUB_REF}\`) — these mirrors are gated from CI instead, on both sides; clone the hub ` +
      'alongside, or set ERPLORA_HUB_DIR, to run them here',
  );
  return null;
}

/**
 * The hub's tags matching `pattern`, as `Map<tag, creation date ISO>`, or `null` after skipping.
 *
 * Only tags ORIGIN RECOGNISES (module-toolkit#258). Being a ref spares this the working tree that
 * `hubPath` has to export around — whichever branch the neighbour sits on cannot change the answer
 * — but it does NOT make the answer the hub's: `git fetch --tags` and `git tag` write the same file,
 * so a ref on disk cannot say who put it there. Measured on the shared checkout on 2026-09-11,
 * `v1.1.22` sat in it for hours before anyone pushed it, and the two table mirrors went red on every
 * branch asserting that «ERPlora/hub published v1.1.22» about a tag no other machine had. The CI of
 * the same commit was green, because the runner clones from origin. Three branches in a row were
 * handed over as "two pre-existing local failures, not mine" — and an alarm whose correct response
 * is to learn to ignore it has stopped being one.
 *
 * This is the same medicine #249 gave the REF and #90 gave the files: do not take a shared checkout
 * at its word, ask its remote. When the remote cannot be asked this SKIPS and says why, which is the
 * honest answer to "what did the hub publish" from a machine that cannot find out — going red over
 * refs that are in nobody's repository is the failure this closes.
 *
 * ⚠️ A checkout with no tags is an honest SKIP, not a failure, and the reason matters:
 * `actions/checkout` does not fetch tags by default, so the hub's own CI can hand over a real
 * checkout that legitimately has none. Failing there would teach everyone to ignore this mirror.
 * What is NOT tolerated is the same thing `hubPath` refuses — a DECLARED hub that is not a
 * repository at all.
 *
 * @param {{skip: (reason: string) => void}} t the test context
 */
export function hubTags(t, pattern, given = {}) {
  const source = asSource(given);
  if (source.kind === 'absent') {
    t.skip(
      `ERPlora/hub is not in this checkout (looked in \`${source.dir}\`) — this mirror is gated ` +
        'from the hub side instead; clone the hub alongside, or set ERPLORA_HUB_DIR, to run it here',
    );
    return null;
  }
  // 🔴 Un hub DECLARADO puede no ser un repositorio, y eso NO es el caso de #61. Medido en la CI de
  // este repo: el paso de espejos declara `ERPLORA_HUB_DIR=…/_actions/ERPlora/hub/develop`, y GitHub
  // resuelve una action DESCARGANDO un tarball — hay ficheros, no hay `.git`. Para `hubPath` esa
  // copia es una fuente perfectamente válida; para los TAGS no puede serlo, porque los tags son refs
  // y un tarball no tiene ninguna. «Un hub declarado que no se puede leer es un error» sigue en pie
  // para los ficheros; aquí no es que el hub esté mal, es que a ESTA pregunta esa copia no contesta.
  // Ponerlo en rojo enseñaría a la CI a ignorar el espejo, que es lo que #61 vino a arreglar.
  const listed = spawnSync(
    'git',
    ['-C', source.dir, 'for-each-ref', '--format=%(refname:short)\t%(creatordate:iso-strict)', `refs/tags/${pattern}`],
    { encoding: 'utf8' },
  );
  if (listed.status !== 0) {
    t.skip(
      `\`${source.dir}\` no es un repositorio git (${(listed.stderr || '').trim() || 'sin stderr'}), ` +
        'así que no puede decir qué tags tiene el hub — un tarball de action tiene los ficheros y ' +
        'ninguna ref. Este espejo corre donde el hub es un clon de verdad, que es la máquina que lo ' +
        'etiqueta y la que tiene que añadir la fila (module-toolkit#201)',
    );
    return null;
  }
  const tags = new Map(
    listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([, date]) => date),
  );
  if (!tags.size) {
    t.skip(
      `\`${source.dir}\` carries no \`${pattern}\` tag. \`actions/checkout\` does not fetch tags ` +
        'by default, so this is a checkout with nothing to compare against, not a divergence — ' +
        'fetch the tags (`git fetch --tags`) to run it',
    );
    return null;
  }

  // Which of them the hub actually PUBLISHED (#258). Asked once per checkout: `releaseTags` runs
  // for each of the four table mirrors, and against github.com that is a network round trip.
  const remote = source.ref ? source.ref.split('/')[0] : DEFAULT_REMOTE;
  const published = publishedTags(source.dir, remote);
  if (published.error) {
    t.skip(
      `could not ask \`${remote}\` which tags it has, from \`${source.dir}\` (${published.error}). ` +
        'A tag on disk does not say who created it — `git fetch --tags` and `git tag` write the ' +
        'same ref — so without the remote there is no way to tell a release of the hub from a ' +
        'local one, and the mirrors that read this would report «the hub published X» about a tag ' +
        'nobody else has (module-toolkit#258)',
    );
    return null;
  }
  for (const tag of tags.keys()) if (!published.names.has(tag)) tags.delete(tag);
  if (!tags.size) {
    t.skip(
      `\`${source.dir}\` carries \`${pattern}\` tags but \`${remote}\` recognises none of them, so ` +
        'they were all created here and there is no hub release to compare against (module-toolkit#258)',
    );
    return null;
  }
  return tags;
}

/**
 * Tag names `remote` recognises, memoised per (checkout, remote) for the same reason `EXPORTED` is:
 * the suite asks the same question once per mirror and the answer cannot change under a test run.
 *
 * Failure is RETURNED, not thrown: unlike `theHubItReallyIs`, which is about to overwrite vendored
 * files and must stop, this feeds guards whose honest answer offline is a skip.
 */
const PUBLISHED = new Map();

function publishedTags(dir, remote) {
  const key = `${dir}\u0000${remote}`;
  if (!PUBLISHED.has(key)) {
    const asked = spawnSync('git', ['-C', dir, 'ls-remote', '--tags', remote], { encoding: 'utf8' });
    PUBLISHED.set(
      key,
      asked.status === 0
        ? {
            names: new Set(
              (asked.stdout || '')
                .split('\n')
                .map((line) => line.split('\t')[1])
                .filter(Boolean)
                // `refs/tags/v1.1.22` and, for an annotated tag, its `^{}` peel. Same name.
                .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')),
            ),
          }
        : { error: (asked.stderr || '').trim().split('\n').pop() || `git exit ${asked.status}` },
    );
  }
  return PUBLISHED.get(key);
}

/**
 * The source a caller passed explicitly. `{ hubDir, declared }` is the older spelling and still
 * means "this directory, read from disk".
 */
function asSource(given) {
  if ('kind' in given) return given;
  if ('hubDir' in given) {
    return { kind: given.declared ? 'declared' : 'absent', dir: given.hubDir };
  }
  return hubSource();
}

/** Whether a checkout carries a ref. Running `git fetch` is the user's call, never this file's. */
function refExists(dir, ref) {
  const probe = spawnSync(
    'git',
    ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    { stdio: 'ignore' },
  );
  return probe.status === 0;
}

/**
 * Exported once per (checkout, ref, path) and reused: the suite asks for the same handful of paths
 * repeatedly, and the scratch directories go with the process.
 */
const EXPORTED = new Map();

/**
 * The requested path, extracted out of `ref` into a scratch directory — `git archive` piped into
 * `tar`, which is the boring way to get a subtree of a ref onto disk and works for a single file
 * and for a whole directory alike (the `.vue` walk of the sixth mirror needs the directory).
 */
function exportedTree({ dir, ref }, segments) {
  const path = segments.join('/');
  const key = `${dir} ${ref} ${path}`;
  const already = EXPORTED.get(key);
  if (already) return already;

  const archive = spawnSync('git', ['-C', dir, 'archive', '--format=tar', ref, '--', path], {
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(
      `\`${path}\` is not in \`${ref}\` of the hub checkout at \`${dir}\` ` +
        `(git archive: ${String(archive.stderr).trim() || `exit ${archive.status}`}). ` +
        'The mirrors read the hub at a ref, never at its working tree (module-toolkit#90), so a ' +
        `stale ref reads as a missing file: run \`git -C ${dir} fetch\` and try again. If the hub ` +
        'really dropped this path, the vendored copy here is what has to go.',
    );
  }

  const root = scratchDir();
  const untar = spawnSync('tar', ['-xf', '-', '-C', root], { input: archive.stdout });
  if (untar.status !== 0) {
    throw new Error(
      `could not extract \`${path}\` of \`${ref}\` into \`${root}\` ` +
        `(tar: ${String(untar.stderr).trim() || `exit ${untar.status}`})`,
    );
  }

  EXPORTED.set(key, root);
  return root;
}

/** A scratch directory that goes away with the process, whatever the run's outcome. */
function scratchDir() {
  const root = mkdtempSync(join(tmpdir(), 'erplora-hub-mirror-'));
  process.on('exit', () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: the OS reclaims `tmpdir()` anyway, and failing to tidy up must never be what
      // turns a green run red.
    }
  });
  return root;
}
