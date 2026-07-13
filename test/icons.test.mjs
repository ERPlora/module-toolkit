// Tests de QUÉ iconos se hornean en `dist/icons.json`. `node --test`.
//
// Bug 2026-07-13 (iconos vacíos en el Hub): `generateIcons` solo horneaba los iconos del MANIFEST
// (`icon` + `navigation[].icon`, para el menú del shell). Pero un módulo también pinta iconos
// DENTRO de su Web Component (`<ion-icon name="file-tray-stacked-outline">` en el TPV), y esos no
// los horneaba nadie: el WC confiaba en que el shell del Hub los tuviera registrados a mano.
//
// El shell no puede saber qué iconos usa un módulo — menos aún uno de TERCEROS instalado desde el
// marketplace. Cuando el nombre no está registrado, ion-icon intenta bajar el SVG por red y en
// offline/CSP el icono sale VACÍO, sin ningún error. Así llevaban rotos el botón de tickets
// aparcados, el de pantalla completa y el carrito flotante del POS.
//
// El módulo tiene que ser AUTÓNOMO: trae sus iconos en el zip, y el shell los registra al cargarlo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIcons } from '../src/icons.mjs';

/** Módulo temporal con un `dist/` y, opcionalmente, el fuente de un Web Component. */
function mod(wcSource) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-icons-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  if (wcSource !== undefined) {
    mkdirSync(join(dir, 'ui', 'components', 'erp-demo'), { recursive: true });
    writeFileSync(join(dir, 'ui', 'components', 'erp-demo', 'erp-demo.ts'), wcSource);
  }
  return dir;
}

const iconsOf = (dir) => JSON.parse(readFileSync(join(dir, 'dist', 'icons.json'), 'utf8'));

test('hornea los iconos que el Web Component pinta por nombre', () => {
  const dir = mod(`
    render() {
      return html\`
        <ion-button><ion-icon slot="icon-only" name="file-tray-stacked-outline"></ion-icon></ion-button>
        <button class="fab"><ion-icon name="cart-outline"></ion-icon></button>\`;
    }`);
  try {
    generateIcons(dir, { icon: 'storefront-outline' });
    const icons = iconsOf(dir);

    // Los del WC — los que salían vacíos en el Hub.
    assert.match(icons['file-tray-stacked-outline'] ?? '', /^<svg/);
    assert.match(icons['cart-outline'] ?? '', /^<svg/);
    // Y el del manifest sigue estando (el menú del shell lo necesita).
    assert.match(icons['storefront-outline'] ?? '', /^<svg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hornea los literales de un icono elegido en runtime (ternario)', () => {
  // `name=${this.fullscreen ? 'contract-outline' : 'expand-outline'}` — el botón de pantalla
  // completa del POS. Los dos literales tienen que viajar, no se sabe cuál se usará.
  const dir = mod(`<ion-icon slot="icon-only" name=\${this.fullscreen ? 'contract-outline' : 'expand-outline'}></ion-icon>`);
  try {
    generateIcons(dir, {});
    const icons = iconsOf(dir);
    assert.match(icons['contract-outline'] ?? '', /^<svg/);
    assert.match(icons['expand-outline'] ?? '', /^<svg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hornea también los iconos que el módulo pasa por prop a un ok-* (OutfitKit)', () => {
  // `<ok-inline-feedback icon="checkmark-circle-outline">` (verifactu): el nombre acaba en un
  // ion-icon dentro del shadow DOM de OutfitKit. Si OutfitKit no lo trae horneado, se resolvería
  // contra el registro del HOST → un módulo de terceros dependería del Hub otra vez. Que viaje.
  const dir = mod(`
    render() {
      return html\`<ok-inline-feedback tone="success" icon="checkmark-circle-outline"></ok-inline-feedback>
                  <ok-kpi icon="ribbon-outline"></ok-kpi>\`;
    }`);
  try {
    generateIcons(dir, {});
    const icons = iconsOf(dir);
    assert.match(icons['checkmark-circle-outline'] ?? '', /^<svg/);
    assert.match(icons['ribbon-outline'] ?? '', /^<svg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reporta el icono que no existe en el set en vez de tragárselo', () => {
  const dir = mod(`<ion-icon name="esto-no-existe-en-ionicons"></ion-icon>`);
  try {
    const { missing } = generateIcons(dir, {});
    assert.ok(missing.includes('esto-no-existe-en-ionicons'), 'debería avisar del icono inexistente');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un módulo sin Web Component sigue funcionando (solo los del manifest)', () => {
  const dir = mod(undefined);
  try {
    generateIcons(dir, { icon: 'cube-outline', navigation: [{ icon: 'list-outline' }] });
    const icons = iconsOf(dir);
    assert.deepEqual(Object.keys(icons).sort(), ['cube-outline', 'list-outline']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
