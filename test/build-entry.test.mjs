// Qué ficheros entran en el bundle del Web Component. `node --test`.
//
// Bug 2026-07-13: `resolveEntry` metía en el bundle TODOS los `.ts` de `ui/components`, así que en
// cuanto un módulo estrenó tests (`erp-pos-touch.test.ts`, TDD) el propio test entró en el
// artefacto publicado, arrastrando vitest… y con él un `new Function()`. Resultado: el build
// abortaba con «1 uso que la CSP estricta bloquearía», porque el Hub sirve el WC bajo
// `script-src 'self'` sin `unsafe-eval`.
//
// El artefacto que se publica lleva SOLO código de producción.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEntry } from '../src/build.mjs';

/** Módulo temporal con los ficheros dados dentro de `ui/components/erp-demo/`. */
function mod(files) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-entry-'));
  const comp = join(dir, 'ui', 'components', 'erp-demo');
  mkdirSync(comp, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(comp, name), body);
  return dir;
}

/** Los ficheros que `resolveEntry` va a meter en el bundle, sea por entryPoints o por stdin. */
function entradas(entry) {
  return entry.entryPoints ?? [...(entry.contents ?? '').matchAll(/import "(.+?)";/g)].map((m) => m[1]);
}

test('los tests NO entran en el bundle del módulo', () => {
  const dir = mod({
    'erp-demo.ts': 'export class A {}',
    'erp-demo.test.ts': 'import { it } from "vitest"; it("x", () => {});',
    'erp-otro.ts': 'export class B {}',
  });
  try {
    const incluidos = entradas(resolveEntry(dir)).join('\n');
    assert.ok(incluidos.includes('erp-demo.ts'), 'el componente sí debe entrar');
    assert.ok(incluidos.includes('erp-otro.ts'), 'el otro componente también');
    assert.ok(!incluidos.includes('.test.ts'), 'un .test.ts NO puede entrar en el artefacto publicado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un módulo con un solo componente y su test resuelve al componente, no al test', () => {
  const dir = mod({
    'erp-demo.ts': 'export class A {}',
    'erp-demo.test.ts': 'import { it } from "vitest"; it("x", () => {});',
  });
  try {
    const incluidos = entradas(resolveEntry(dir));
    assert.equal(incluidos.length, 1, 'solo el componente');
    assert.match(incluidos[0], /erp-demo\.ts$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
