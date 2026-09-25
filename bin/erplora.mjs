#!/usr/bin/env node
// CLI del toolkit de módulos ERPlora (estilo Ionic).
//   erplora startproject <n>   workspace contenedor de dev (Ionic + OutfitKit por defecto)
//   erplora g module <id>      genera un módulo (repo propio) con WC Lit + SQL + fixtures
//   erplora g view|command|query <id> <name>   genera piezas dentro de un módulo
//   erplora dev <dir>          preview con transport mock, CSP-safe
//   erplora build <dir>        compila el WC a dist/<id>.esm.js
//   erplora validate <dir> [--pg]  valida manifest + CSP del bundle + contratos (ADR-0127);
//                              con --pg, PREPARA cada SQL contra un Postgres efímero (#32)
//   erplora test <dir>         corre las baterías propias del módulo (contrato + Postgres + hub) y
//                              sus tests de TypeScript (`ui/**/*.test.ts`, vitest + happy-dom)
//                              `--list` las enumera sin correrlas (lo que usa el gate compartido)
//                              `--against-hub [<imagen>]` levanta el kernel REAL y corre contra él
//                              las baterías `*.hub.test.py|.sh` (module-toolkit#110)
//   erplora contracts <dir>    (re)genera .erplora/contracts.json
//   erplora pack|sign|publish  empaquetado/firma/publicación al marketplace (§7.4)
//
// Only `validate` is imported statically. The rest of the commands are loaded ON DEMAND because
// they pull heavy third-party packages (esbuild, lit, @ionic/core, @iconify) that the CI gate of
// the module repos does not — and cannot — install: three of this package's (dev) dependencies are
// `file:` paths into sibling checkouts (`../hub/...`, `../outfitkit`) that do not exist on a
// runner, so a plain `npm install` cannot link them and the gate installs the public ones by hand
// (ERPlora/pm#107). Loading `build.mjs` just to run `validate` made the CLI die with
// `ERR_MODULE_NOT_FOUND: esbuild` before parsing a single argument.
import { validate } from '../src/validate.mjs';
import { parseAgainstHub } from '../src/against-hub.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
// `erplora --version` (module-toolkit#277): the first thing anyone types to confirm an install.
// Answered before any other parsing, so it works from any install that can start the bin.
if (argv[0] === '--version' || argv[0] === '-v') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
// `--against-hub [<imagen|digest>]` is the ONE flag that takes a value, and a value does not start
// with `--`: left in, it would land in `rest` and be read as the module directory (module-toolkit
// #110). It is consumed first, once, so the split below keeps meaning what it always meant.
const againstHub = parseAgainstHub(argv, { positionals: true });
// Flags are separated from positional args so `erplora validate <dir> --pg` works in any order.
const flags = new Set(againstHub.positionals.filter((a) => a.startsWith('--')));
const [cmd, ...rest] = againstHub.positionals.filter((a) => !a.startsWith('--'));

// Acepta una ruta o un id suelto: desde un workspace, `erplora build inventory` → modules/inventory.
const target = (arg) => {
  if (!arg) return arg;
  if (existsSync(join(process.cwd(), arg, 'module.json'))) return arg;
  if (existsSync(join(process.cwd(), 'modules', arg, 'module.json'))) return join('modules', arg);
  return arg;
};

const usage = () => {
  console.log(`uso: erplora <comando>

  -v, --version                  muestra la versión instalada del toolkit
  startproject <nombre>          crea un workspace de dev (Ionic + OutfitKit instalados)
  g module <id>                  genera un módulo nuevo (repo propio)
  g view <id> <vista>            añade una vista (Web Component Lit) a un módulo
  g command|query <id> <nombre>  añade un command/query SQL a un módulo
  dev <dir>                      preview del módulo con datos mock (CSP-safe)
  build <dir>                    compila el WebComponent → dist/<id>.esm.js
  validate <dir> [--pg]          valida el manifest + CSP del bundle + contratos (ADR-0127);
                                 con --pg, además PREPARA cada SQL contra un Postgres efímero
  test <dir> [--list] [--against-hub [<imagen|digest>]]
                                 corre las baterías propias del módulo (cualquier
                                 tests/**/*.test.py|.sh; las que necesitan Postgres —por nombre
                                 \`.pg.\`/\`.postgres.\` o porque leen el contenedor— usan el de
                                 \`ERPLORA_TEST_PG_CONTAINER\`) Y sus tests de TypeScript
                                 (\`ui/**/*.test.ts\` bajo vitest + happy-dom; el binario se puede
                                 fijar con \`ERPLORA_VITEST\`) Y los tests RUST del handler
                                 (\`#[cfg(test)]\` en \`handler/**\`, bajo \`cargo test\`: fuera
                                 del monorepo necesitan un checkout del hub en
                                 \`ERPLORA_HUB_DIR\`, y sin él salen como «sin correr», nunca en
                                 verde). Falla si queda un test que nadie
                                 va a ejecutar. \`--list\` solo los enumera.
                                 Con \`--against-hub\` levanta la imagen PUBLICADA del kernel
                                 (\`ghcr.io/erplora/hub:stable\` por defecto; \`dev\`, un
                                 \`sha256:…\` o una referencia completa también valen) con su
                                 Postgres, instala el módulo por \`POST /api/modules/install\` y
                                 corre contra ÉL las baterías \`tests/**/*.hub.test.py|.sh\`
  contracts <dir>                (re)genera .erplora/contracts.json (superficie consumida)
  pack <dir>                     module.zip + manifest.lock + SHA256
  sign <dir>                     SHA256 + firma ed25519 (\`<zip>.sig\`, MODULE_SIGNING_KEY)
  publish <dir>                  guía de publicación al marketplace (no automatizado)`);
  process.exit(2);
};

const need = (v, msg) => { if (!v) { console.error('✗ ' + msg); usage(); } };

try {
  switch (cmd) {
    case 'startproject':
      need(rest[0], 'falta el nombre del proyecto');
      await (await import('../src/scaffold.mjs')).startproject(rest[0]);
      break;
    case 'g':
    case 'generate':
      need(rest[0], 'falta el tipo (module|view|command|query)');
      await (await import('../src/scaffold.mjs')).generate(rest[0], ...rest.slice(1));
      break;
    case 'dev': {
      // Sin arg → workspace completo (página main). Con id/dir → preselecciona ese módulo.
      // Si el primer arg es un puerto numérico, trátalo como puerto (workspace en ese puerto).
      const isPort = rest[0] && /^\d+$/.test(rest[0]);
      const modArg = isPort ? undefined : target(rest[0]);
      const port = Number(isPort ? rest[0] : rest[1]) || undefined;
      await (await import('../src/dev.mjs')).dev(modArg, { port });
      break;
    }
    case 'build':
      need(rest[0], 'falta la ruta del módulo');
      await (await import('../src/build.mjs')).build(target(rest[0]));
      break;
    case 'validate':
      need(rest[0], 'falta la ruta del módulo');
      await validate(target(rest[0]), { pg: flags.has('--pg') });
      break;
    case 'test': {
      // module-toolkit#50: the batteries the module ALREADY carries. Statically imported like
      // `validate` — it pulls nothing but node builtins, and the gate runs it on a runner where
      // `npm install` is impossible.
      need(rest[0], 'falta la ruta del módulo');
      const dir = target(rest[0]);
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { discoverBatteries, runBatteries } = await import('../src/run-batteries.mjs');
      // module-toolkit#74: and the module's TypeScript tests — `ui/**/*.test.ts`, the Web Component
      // checks where nearly all of the screen logic lives. 210 of them across the 25 repos, and
      // until this the gate ran zero.
      const { discoverTsTests, runTsTests } = await import('../src/run-vitest.mjs');
      // module-toolkit#146: and the handler's RUST tests — the `#[cfg(test)] mod tests` of a Tier-2
      // module, where its business logic lives. 925 of them across 21 repos, and until this the gate
      // ran zero: the crate reaches the hub's guest-sdk by a relative path that only exists in the
      // monorepo, so `run-cargo.mjs` builds the layout that path expects out of the hub checkout the
      // gate already has on disk.
      const { discoverRustTests, runRustTests } = await import('../src/run-cargo.mjs');
      // `--list`: what WOULD run, one path per line, and nothing else on stdout. The shared gate
      // asks the toolkit instead of re-implementing the discovery rule in YAML — which is how the
      // gate's own `ls` of two suffixes ended up disagreeing with the toolkit (module-toolkit#55).
      if (flags.has('--list')) {
        const all = [
          ...Object.values(discoverBatteries(dir)).flat(),
          ...discoverTsTests(dir),
          ...discoverRustTests(dir),
        ];
        for (const f of all.sort()) console.log(f);
        break;
      }
      const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
      // The container the gate started. Empty string = none, same as unset.
      const container = process.env.ERPLORA_TEST_PG_CONTAINER || null;
      // `tests/schemas.contract.test.py` NEEDS `jsonschema` and REFUSES to skip without it
      // («skipping would turn a validation test into a green light for nothing»), so the gate hands
      // over the python of a venv that has it. Choosing the interpreter is what lets it do that
      // without touching the 25 module repos.
      const python = process.env.ERPLORA_PYTHON || 'python3';
      // One body, run either bare or inside a live kernel: the report has to read the same way in
      // both, and duplicating it is how the two would drift.
      const runEverything = (liveHub) => {
        const py = runBatteries(dir, manifest, { container, python, hub: liveHub });
        // The TypeScript half runs under vitest, which the gate installs next to the module and
        // hands over through `ERPLORA_VITEST` — the same door `ERPLORA_PYTHON` opens for the
        // batteries.
        const ts = runTsTests(dir);
        // The Rust half needs a checkout of ERPlora/hub for the handler's `path` dependency to
        // resolve; the gate hands it over in `ERPLORA_HUB_DIR`, the same door `ERPLORA_PYTHON` and
        // `ERPLORA_VITEST` open for the other two families. Without it they are NOT RUN, by name.
        const rust = runRustTests(dir);
        const results = [...py.results, ...ts.results, ...rust.results];
        const errors = [...py.errors, ...ts.errors, ...rust.errors];
        const notRun = [...py.notRun, ...ts.notRun, ...rust.notRun];
        for (const r of results.filter((x) => x.ran)) console.log(`  ✓ ${r.file}`);
        // Never a silent pass: what did not run is named, every time.
        for (const n of notRun) console.warn(`  ⚠ ${n}`);
        if (errors.length) {
          throw new Error(
            `baterías del módulo (module-toolkit#50/#74/#110):\n  - ${errors.join('\n  - ')}`,
          );
        }
        const ran = results.filter((x) => x.ran).length;
        console.log(
          ran || notRun.length
            ? `✓ test ${manifest.id}: ${ran} batería(s) en verde` +
                (notRun.length ? `, ${notRun.length} sin correr` : '')
            : `✓ test ${manifest.id}: sin baterías propias (0 baterías en tests/ ni en ui/)`,
        );
      };
      // module-toolkit#110: with `--against-hub` the `*.hub.test.py|.sh` batteries run against the
      // PUBLISHED kernel image — its installer, its dispatcher, its Postgres — instead of against a
      // scratch database that imitates it. Loaded on demand like the heavy commands: it reaches for
      // Docker, and `--list` (what the shared gate calls) must never pay for that.
      if (againstHub.present) {
        const { resolveImageRef, withHubRuntime } = await import('../src/against-hub.mjs');
        const image = resolveImageRef(againstHub.value);
        console.log(`→ ${manifest.id} contra el runtime REAL ${image}`);
        // Docker needs an absolute path to bind-mount, and `dir` is whatever the caller typed.
        await withHubRuntime(
          { dir: resolve(dir), manifest, image, log: (line) => console.log(line) },
          async (live) => {
            console.log(`  · runtime en ${live.baseUrl}`);
            runEverything(live);
          },
        );
      } else {
        runEverything(null);
      }
      break;
    }
    case 'contracts': {
      need(rest[0], 'falta la ruta del módulo');
      const dir = target(rest[0]);
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { writeContractsFile } = await import('../src/contracts.mjs');
      const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
      const c = writeContractsFile(dir, manifest);
      const n = Object.values(c.consumes).reduce((a, l) => a + l.length, 0);
      console.log(`✓ contracts ${manifest.id}: .erplora/contracts.json (${n} contratos consumidos)`);
      break;
    }
    case 'pack':
      need(rest[0], 'falta la ruta del módulo');
      await (await import('../src/pack.mjs')).pack(target(rest[0]));
      break;
    case 'sign':
      need(rest[0], 'falta la ruta del módulo');
      await (await import('../src/pack.mjs')).sign(target(rest[0]));
      break;
    case 'publish':
      need(rest[0], 'falta la ruta del módulo');
      await (await import('../src/pack.mjs')).publish(target(rest[0]));
      break;
    default:
      usage();
  }
} catch (err) {
  // 🔴 Exit only once the report is out (sales#362). Into a pipe, `process.exit` right after a big
  // write keeps the first 64 KB and drops the rest — and the tail is where vitest names the test
  // behind an «Errors 1 error». Each stream's empty-write callback runs after what came before it.
  process.stderr.write('✗ ' + err.message + '\n', () =>
    process.stdout.write('', () => process.exit(1)),
  );
}
