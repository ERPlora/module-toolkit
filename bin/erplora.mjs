#!/usr/bin/env node
// CLI del toolkit de módulos ERPlora (estilo Ionic).
//   erplora startproject <n>   workspace contenedor de dev (Ionic + OutfitKit por defecto)
//   erplora g module <id>      genera un módulo (repo propio) con WC Lit + SQL + fixtures
//   erplora g view|command|query <id> <name>   genera piezas dentro de un módulo
//   erplora dev <dir>          preview con transport mock, CSP-safe
//   erplora build <dir>        compila el WC a dist/<id>.esm.js
//   erplora validate <dir>     valida manifest + CSP del bundle + contratos (ADR-0127)
//   erplora contracts <dir>    (re)genera .erplora/contracts.json
//   erplora pack|sign|publish  empaquetado/firma/publicación al marketplace (§7.4)
import { build } from '../src/build.mjs';
import { validate } from '../src/validate.mjs';
import { startproject, generate } from '../src/scaffold.mjs';
import { dev } from '../src/dev.mjs';
import { pack, sign, publish } from '../src/pack.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

// Acepta una ruta o un id suelto: desde un workspace, `erplora build inventory` → modules/inventory.
const target = (arg) => {
  if (!arg) return arg;
  if (existsSync(join(process.cwd(), arg, 'module.json'))) return arg;
  if (existsSync(join(process.cwd(), 'modules', arg, 'module.json'))) return join('modules', arg);
  return arg;
};

const usage = () => {
  console.log(`uso: erplora <comando>

  startproject <nombre>          crea un workspace de dev (Ionic + OutfitKit instalados)
  g module <id>                  genera un módulo nuevo (repo propio)
  g view <id> <vista>            añade una vista (Web Component Lit) a un módulo
  g command|query <id> <nombre>  añade un command/query SQL a un módulo
  dev <dir>                      preview del módulo con datos mock (CSP-safe)
  build <dir>                    compila el WebComponent → dist/<id>.esm.js
  validate <dir>                 valida el manifest + CSP del bundle + contratos (ADR-0127)
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
      await startproject(rest[0]);
      break;
    case 'g':
    case 'generate':
      need(rest[0], 'falta el tipo (module|view|command|query)');
      await generate(rest[0], ...rest.slice(1));
      break;
    case 'dev': {
      // Sin arg → workspace completo (página main). Con id/dir → preselecciona ese módulo.
      // Si el primer arg es un puerto numérico, trátalo como puerto (workspace en ese puerto).
      const isPort = rest[0] && /^\d+$/.test(rest[0]);
      const modArg = isPort ? undefined : target(rest[0]);
      const port = Number(isPort ? rest[0] : rest[1]) || undefined;
      await dev(modArg, { port });
      break;
    }
    case 'build':
      need(rest[0], 'falta la ruta del módulo');
      await build(target(rest[0]));
      break;
    case 'validate':
      need(rest[0], 'falta la ruta del módulo');
      await validate(target(rest[0]));
      break;
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
      await pack(target(rest[0]));
      break;
    case 'sign':
      need(rest[0], 'falta la ruta del módulo');
      await sign(target(rest[0]));
      break;
    case 'publish':
      need(rest[0], 'falta la ruta del módulo');
      await publish(target(rest[0]));
      break;
    default:
      usage();
  }
} catch (err) {
  console.error('✗ ' + err.message);
  process.exit(1);
}
