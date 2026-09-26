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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Bug 2026-08-05 (#22, real case ERPlora/inventory#32): the baker only scanned MARKUP
// (`<ion-icon name=…>`, `<ok-* icon=…>`), not icon names passed as DATA — the `icon:` literals in
// the `actions` arrays a module hands to ok-data-table via JS props. A blind rebuild of
// `dist/icons.json` for the inventory module dropped 5 icons that were in use (eye, create, trash,
// download, calculator-outline) and they rendered BLANK in the Hub.
test('bakes the icon: literals of ok-data-table actions (data, not markup)', () => {
  // Verbatim shape from inventory's erp-inventory-products.ts — the exact case that lost 5 icons.
  const dir = mod(`
    private actions(): DataTableAction[] {
      return [
        { id: 'detail', label: t('ui.actionDetail'), icon: 'eye-outline' },
        { id: 'receive', label: t('ui.actionReceive'), icon: 'download-outline' },
        { id: 'count', label: t('ui.actionCount'), icon: 'calculator-outline' },
        ...(this.canEdit ? [{ id: 'edit', label: t('ui.actionEdit'), icon: 'create-outline' }] : []),
        ...(this.canDelete ? [{ id: 'delete', label: t('ui.actionDelete'), icon: 'trash-outline', color: 'danger' }] : []),
      ];
    }`);
  try {
    generateIcons(dir, {});
    const icons = iconsOf(dir);
    for (const name of ['eye-outline', 'download-outline', 'calculator-outline', 'create-outline', 'trash-outline']) {
      assert.match(icons[name] ?? '', /^<svg/, `${name} should be baked`);
    }
    // Neighbouring string literals are NOT icons: don't bake the label key or the color.
    assert.equal(icons['ui.actionDelete'], undefined);
    assert.equal(icons['danger'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bakes the literal fallback of a runtime icon (icon: expr ?? \'cube-outline\')', () => {
  // inventory's categories table: `icon: (r.icon as string) ?? 'cube-outline'` — the variable part
  // is not bakeable, but the literal fallback is in use and must travel.
  const dir = mod(`rows.map((r) => ({ label: r.name, icon: (r.icon as string) ?? 'cube-outline' }))`);
  try {
    generateIcons(dir, {});
    assert.match(iconsOf(dir)['cube-outline'] ?? '', /^<svg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a TypeScript `icon: string` type annotation bakes nothing (no garbage)', () => {
  const dir = mod(`
    interface DataTableAction {
      icon: string;
      label: 'primary' | 'secondary';
    }`);
  try {
    const { missing } = generateIcons(dir, {});
    assert.deepEqual(Object.keys(iconsOf(dir)), []);
    assert.deepEqual(missing, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bakes icon literals bound to icon-suffixed props (.cardIcon of ok-data-table)', () => {
  // Real case (customers, cart_checkout): `.cardIcon=${() => 'person-outline'}` — the icon of the
  // mobile auto-cards mode. The bound-attribute scan only matched a prop named exactly `icon`, so a
  // rebuild lost these too. Any `…icon`/`…Icon`-suffixed prop of an ok-* may carry icon names.
  const dir = mod(`
    render() {
      return html\`<ok-data-table .serverSide=\${true} .cardIcon=\${() => 'person-outline'} .rows=\${this.rows}></ok-data-table>
                  <ok-data-table .cardIcon=\${(r) => (r.vip ? 'star' : 'pricetag-outline')}></ok-data-table>\`;
    }`);
  try {
    generateIcons(dir, {});
    const icons = iconsOf(dir);
    for (const name of ['person-outline', 'star', 'pricetag-outline']) {
      assert.match(icons[name] ?? '', /^<svg/, `${name} should be baked`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bakes manifest icons beyond the top level: settings.icon and widgets.*.icon', () => {
  // Same bug class as the actions (#22), found while re-baking the real inventory module: the baker
  // only read `manifest.icon` + `navigation[].icon`, but the manifest also declares icons in
  // `settings.icon` and in the dashboard `widgets` blocks (ADR-0054). A blind rebuild dropped
  // cash-outline and trending-down-outline (inventory's widget icons).
  const dir = mod(undefined);
  try {
    generateIcons(dir, {
      icon: 'cube-outline',
      settings: { icon: 'options-outline' },
      widgets: {
        inventory: {
          value: { icon: 'cash-outline', options: { icon: 'cash-outline' } },
          low_stock_products: { icon: 'trending-down-outline' },
        },
      },
    });
    const icons = iconsOf(dir);
    for (const name of ['cube-outline', 'options-outline', 'cash-outline', 'trending-down-outline']) {
      assert.match(icons[name] ?? '', /^<svg/, `${name} should be baked`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Verification against the REAL inventory module: the component that declares the 5 action icons
// lost in ERPlora/inventory#32, frozen byte for byte under test/fixtures/real-modules
// (ERPlora/inventory@d4e4263), is copied to a temp dir and baked. It used to be read from the sibling
// modules workspace, which no CI runner has, so it skipped on every pull request
// (module-toolkit#352). A missing fixture is a FAILURE here, never a skip.
test('real inventory module: the 5 action icons of inventory#32 end up baked', () => {
  const inventoryUi = fileURLToPath(new URL('./fixtures/real-modules/inventory/ui', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'erplora-icons-inventory-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  cpSync(inventoryUi, join(dir, 'ui'), { recursive: true });
  try {
    generateIcons(dir, {});
    const icons = iconsOf(dir);
    for (const name of ['eye-outline', 'create-outline', 'trash-outline', 'download-outline', 'calculator-outline']) {
      assert.match(icons[name] ?? '', /^<svg/, `${name} should be baked`);
    }
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
