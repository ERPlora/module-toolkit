// El SELLO de OutfitKit que `erplora build` deja en `dist/` (ERPlora/hub#1024). `node --test`.
//
// Un módulo publicado hornea su PROPIA copia de OutfitKit — el toolkit la resuelve desde sus
// `node_modules` (`file:../outfitkit`), o sea el checkout local de quien construyó. En un hub real
// esa copia casi nunca es la que manda: el shell define sus `ok-*` al arrancar y el `define()`
// horneado está GUARDADO (`if (!customElements.get(tag))`), así que **pierde en silencio**. La
// imagen del hub, además, instala `@erplora/outfitkit@latest` en cada build.
//
// Resultado: en la flota conviven dos OutfitKit reparidos elemento por elemento, y **nadie compara
// esas dos versiones en ningún punto**. Un cambio de contrato rompe módulos publicados sin que
// ningún test lo vea — y en `pnpm dev` no reproduce, porque ahí las dos copias son el mismo
// checkout.
//
// El sello es la mitad barata del arreglo: el bundle dice CON QUÉ versión se construyó, y el shell
// puede avisar cuando descarta una copia distinta a la suya. No arregla la deriva; la hace visible,
// que es lo que hoy no es.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stampOutfitkit, OUTFITKIT_STAMP } from '../src/outfitkit-stamp.mjs';

function mod() {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-stamp-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  return dir;
}

const stampOf = (dir) => JSON.parse(readFileSync(join(dir, 'dist', OUTFITKIT_STAMP), 'utf8'));

test('deja en dist la versión de OutfitKit que ha horneado', () => {
  const dir = mod();
  try {
    stampOutfitkit(dir, { version: '0.1.40' });
    assert.equal(stampOf(dir).outfitkit, '0.1.40');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la lee del paquete REAL que el bundler acaba de usar, no de un literal', () => {
  // El sello vale exactamente lo que valga su fuente: si la lee de otro sitio que el resolvedor,
  // miente en el único caso que importa — cuando las dos difieren.
  const dir = mod();
  const pkgDir = mkdtempSync(join(tmpdir(), 'erplora-ok-'));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@erplora/outfitkit', version: '9.9.9' }));
  try {
    stampOutfitkit(dir, { packageDir: pkgDir });
    assert.equal(stampOf(dir).outfitkit, '9.9.9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

test('sin OutfitKit resoluble NO inventa una versión: no escribe sello', () => {
  // Un sello con «unknown» dentro se lee igual que uno real y desarma el aviso del shell. Mejor no
  // haberlo: la ausencia es un estado que el shell ya sabe tratar (los 25 módulos publicados hoy).
  const dir = mod();
  try {
    stampOutfitkit(dir, { packageDir: join(dir, 'no-existe') });
    assert.equal(existsSync(join(dir, 'dist', OUTFITKIT_STAMP)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
