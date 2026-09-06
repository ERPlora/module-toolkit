// Tests de QUÉ entra en el `module.zip`. `node --test`.
//
// Bug 2026-07-10 (fichas del marketplace sin documentación): el SaaS extrae `README.md` y
// `CHANGELOG.md` del ZIP en cada sync (`extract_module_docs_from_zip`) y los guarda en
// `Module.readme`/`Module.changelog` para pintarlos en `/marketplace/<slug>/` sin ir a S3 en
// runtime (ADR-0106). Pero `pack` nunca los metía en el ZIP, así que el campo llegaba SIEMPRE
// vacío y la ficha caía al fallback `long_description` → `description`.
//
// El ZIP es la fuente de verdad de la documentación publicada. Si un fichero no entra aquí,
// no existe para el marketplace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INCLUDE, packedPaths } from '../src/pack.mjs';

/** Módulo temporal con exactamente los ficheros/carpetas de `entries` (rutas relativas). */
function mod(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-pack-'));
  for (const rel of entries) {
    if (rel.endsWith('/')) mkdirSync(join(dir, rel), { recursive: true });
    else writeFileSync(join(dir, rel), 'x');
  }
  return dir;
}

test('el ZIP declara README.md y CHANGELOG.md', () => {
  assert.ok(INCLUDE.includes('README.md'), `INCLUDE sin README.md: ${INCLUDE.join(', ')}`);
  assert.ok(INCLUDE.includes('CHANGELOG.md'), `INCLUDE sin CHANGELOG.md: ${INCLUDE.join(', ')}`);
});

test('la documentación viaja en el ZIP cuando el módulo la trae', () => {
  const dir = mod(['module.json', 'README.md', 'CHANGELOG.md', 'migrations/', 'locales/']);
  try {
    const packed = packedPaths(dir);
    assert.ok(packed.includes('README.md'), `README.md fuera del zip: ${packed.join(', ')}`);
    assert.ok(packed.includes('CHANGELOG.md'), `CHANGELOG.md fuera del zip: ${packed.join(', ')}`);
    assert.ok(packed.includes('module.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// module-toolkit#209: the automations a module ships with. It writes them in `flows/`, publishes,
// and they reach NO hub — the folder was not in `INCLUDE`, so the zip left it behind. The only door
// that stayed open was a hand-written COPY of the template in the gallery of the `flows` module,
// and a copy falls behind: it did three times in a single day.
test('el ZIP declara flows/ — las automatizaciones de fábrica del módulo (#209)', () => {
  assert.ok(INCLUDE.includes('flows'), `INCLUDE sin flows: ${INCLUDE.join(', ')}`);
});

test('las automatizaciones de fábrica viajan en el ZIP cuando el módulo las trae (#209)', () => {
  const dir = mod(['module.json', 'flows/', 'migrations/']);
  try {
    const packed = packedPaths(dir);
    assert.ok(packed.includes('flows'), `flows/ fuera del zip: ${packed.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un módulo sin documentación sigue empaquetando (no es obligatoria)', () => {
  const dir = mod(['module.json', 'migrations/']);
  try {
    const packed = packedPaths(dir);
    assert.ok(!packed.includes('README.md'));
    assert.ok(!packed.includes('CHANGELOG.md'));
    assert.deepEqual(packed, ['module.json', 'migrations']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no se cuela nada que no esté declarado (node_modules, fuentes TS, fixtures)', () => {
  const dir = mod(['module.json', 'node_modules/', 'ui/', 'fixtures/', 'handler/', 'build/']);
  try {
    assert.deepEqual(packedPaths(dir), ['module.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
