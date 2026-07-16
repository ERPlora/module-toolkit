// Qué ficheros entran en el bundle del PREVIEW (`erplora dev`). `node --test`.
//
// Bug 2026-07-16: el mismo del build (test/build-entry.test.mjs, 07-13) pero en el harness
// de dev — `collectTs` metía TODOS los `.ts` de `ui/`, tests incluidos. En cuanto un módulo
// estrenó tests junto al componente (inventory#8/#13, TDD), `harness.js` arrastró vitest y
// el preview moría en blanco («Vitest failed to find the runner»). El preview carga SOLO
// código de producción, igual que el artefacto publicado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTs } from '../src/dev.mjs';

function dir(files) {
  const d = mkdtempSync(join(tmpdir(), 'erplora-devcollect-'));
  for (const [name, body] of Object.entries(files)) {
    const full = join(d, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return d;
}

test('collectTs excluye *.test.ts y *.spec.ts (el preview es solo producción)', () => {
  const d = dir({
    'erp-demo/erp-demo.ts': 'export const a = 1;',
    'erp-demo/erp-demo.test.ts': 'import { test } from "vitest";',
    'erp-demo/erp-demo.spec.ts': 'import { test } from "vitest";',
    'lib/helper.ts': 'export const b = 2;',
  });
  const found = collectTs(d).map((f) => f.split('/').pop()).sort();
  assert.deepEqual(found, ['erp-demo.ts', 'helper.ts']);
});

test('collectTs sigue excluyendo d.ts, dist y ocultos', () => {
  const d = dir({
    'erp-demo/erp-demo.ts': 'export const a = 1;',
    'erp-demo/types.d.ts': 'export type X = 1;',
    'dist/erp-demo.ts': 'no',
    '.hidden/erp-demo.ts': 'no',
  });
  const found = collectTs(d).map((f) => f.split('/').pop());
  assert.deepEqual(found, ['erp-demo.ts']);
});
