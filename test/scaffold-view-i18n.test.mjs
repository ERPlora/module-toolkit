// module-toolkit#366: the view the generator writes has to be born like every other create flow in
// the product — the form inside the table's create panel, its submit button saying «Save»/«Guardar»
// and every visible string going through the module's translation catalogue (ADR-0055).
//
// It used to be born with a loose `<form>` above the table, a submit button labelled «Añadir» and
// hand-written Spanish («Nombre», «Guardando…», «No se pudo crear»). Once a module moved that form
// into the table's create panel, the panel ended up with two «Añadir» buttons — the toolbar one that
// opens it and the one that saves — and the screen stayed in Spanish for an English-speaking user.
// pricing#50, customers#96 and staff#74 had to be fixed one by one; the generator is the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../src/scaffold.mjs';

const COMP = 'ui/components/erp-demo-mod-items/erp-demo-mod-items.ts';

async function inScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'erplora-scaffold-i18n-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
}

/** The source with every `${…}` expression cut out (balanced braces), so only literal text remains. */
function withoutExpressions(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 0;
      for (i += 1; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
      }
      out += '${}';
      continue;
    }
    out += src[i];
  }
  return out;
}

/** The body of the `html\`…\`` returned by `render()`, expressions removed. */
function renderedTemplate(src) {
  const start = src.indexOf('render()');
  assert.ok(start >= 0, 'the generated view has no render()');
  const body = withoutExpressions(src.slice(start));
  const open = body.indexOf('html`');
  const close = body.indexOf('`', open + 5);
  return body.slice(open + 5, close);
}

const dig = (obj, key) => key.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), obj);

test('g module: the create submit button says Save/Guardar and lives in the table create panel (#366)', async () => {
  await inScratch(async (root) => {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');
    const src = readFileSync(join(dir, COMP), 'utf8');
    const tpl = renderedTemplate(src);

    // The form is projected into the create panel of an addable table — the toolbar «+ Add» of
    // ok-data-table opens it — and not left loose above the table.
    assert.match(src, /<ok-data-table[^>]*\.addable=\$\{true\}/, 'the table does not declare addable');
    assert.match(tpl, /<ok-data-table[\s\S]*<form slot="create"[\s\S]*<\/form>\s*<\/ok-data-table>/, 'the create form is not inside the table create panel');

    // The submit button is labelled with the catalogue's Save key, never with «Add».
    const submit = src.match(/<ion-button type="submit"[^>]*>([\s\S]*?)<\/ion-button>/);
    assert.ok(submit, 'no submit button in the generated view');
    assert.match(submit[1], /t\('ui\.save'\)/, `the submit button is not labelled with ui.save: ${submit[1].trim()}`);
    assert.doesNotMatch(submit[1], /Añadir|\bAdd\b|ui\.add/i, 'the submit button still says Add');

    const en = JSON.parse(readFileSync(join(dir, 'locales/en.json'), 'utf8'));
    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'));
    assert.equal(dig(en, 'ui.save'), 'Save');
    assert.equal(dig(es, 'ui.save'), 'Guardar');
  });
});

test('g module: the generated view has no hand-written visible text and every key has en + es (#366)', async () => {
  await inScratch(async (root) => {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');
    const src = readFileSync(join(dir, COMP), 'utf8');

    // No literal text between tags, no literal placeholder/label attributes, no literal headers.
    const tpl = renderedTemplate(src).replace(/<!--[\s\S]*?-->/g, '');
    const textNodes = [...tpl.matchAll(/>([^<]*)</g)].map((m) => m[1].replace(/\$\{\}/g, '').trim()).filter(Boolean);
    assert.deepEqual(textNodes, [], 'hand-written text between tags');
    assert.doesNotMatch(tpl, /\s(placeholder|label|header)="[^"]*[A-Za-zÀ-ÿ]/, 'hand-written placeholder/label attribute');
    assert.doesNotMatch(src, /header:\s*['"`]/, 'a column header is a literal string');
    assert.doesNotMatch(src, /\$\{\s*['"`][^'"`]*[A-Za-zÀ-ÿ]/, 'a literal string bound into the template');
    for (const word of ['Nombre', 'Código', 'Importe', 'Guardando', 'Añadir', 'No se pudo', 'Buscar', 'Cargando', 'Sin datos']) {
      assert.ok(!src.includes(word), `hand-written Spanish left in the generated view: «${word}»`);
    }

    // The texts follow a language switch without a reload (the shell fires erplora:locale-changed),
    // and a failed save never paints the server's text — it can carry driver internals (pricing#29).
    assert.match(src, /addEventListener\('erplora:locale-changed'/, 'the view does not re-render on a language switch');
    assert.match(src, /private get columns\(\)/, 'the column headers are frozen at construction, not per render');
    assert.doesNotMatch(src, /formError\s*=[^;]*\.message/, 'the server error text reaches the screen');
    // Same for a failed list load: the controller's `error` is the raw server message (or the SDK's
    // fixed Spanish fallback), so the view shows its own translated text instead.
    assert.doesNotMatch(src, /\$\{\s*this\.ctrl\??\.error\s*\}/, 'the list load error paints the server text');

    // Every key the view asks the catalogue for exists in en AND es, and the catalogue is the
    // module's own (imported, so esbuild inlines it into dist).
    assert.match(src, /import esLocale from '\.\.\/\.\.\/\.\.\/locales\/es\.json'/);
    assert.match(src, /import enLocale from '\.\.\/\.\.\/\.\.\/locales\/en\.json'/);
    const keys = [...new Set([...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]))];
    assert.ok(keys.length >= 8, `too few translated strings, found ${keys.join(', ')}`);
    const en = JSON.parse(readFileSync(join(dir, 'locales/en.json'), 'utf8'));
    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'));
    for (const k of keys) {
      assert.equal(typeof dig(en, k), 'string', `locales/en.json has no ${k}`);
      assert.equal(typeof dig(es, k), 'string', `locales/es.json has no ${k}`);
    }

    // The module name and its menu entry are translated too: the runtime reads them from here.
    assert.equal(typeof en.name, 'string');
    assert.equal(typeof es.name, 'string');
    assert.equal(typeof dig(en, 'navigation.items.label'), 'string');
    assert.equal(typeof dig(es, 'navigation.items.label'), 'string');
  });
});

test('g view: the new view brings its keys to the module catalogue without overwriting it (#366)', async () => {
  await inScratch(async (root) => {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');
    // The developer already translated the save button their own way.
    const esPath = join(dir, 'locales/es.json');
    const es0 = JSON.parse(readFileSync(esPath, 'utf8'));
    es0.ui.save = 'Guardar cambios';
    writeFileSync(esPath, JSON.stringify(es0, null, 2) + '\n');

    await generate('view', 'demo_mod', 'orders');
    const src = readFileSync(join(dir, 'ui/components/erp-demo-mod-orders/erp-demo-mod-orders.ts'), 'utf8');
    const en = JSON.parse(readFileSync(join(dir, 'locales/en.json'), 'utf8'));
    const es = JSON.parse(readFileSync(esPath, 'utf8'));
    assert.equal(es.ui.save, 'Guardar cambios', 'g view overwrote a translation the developer wrote');
    for (const k of new Set([...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]))) {
      assert.equal(typeof dig(en, k), 'string', `locales/en.json has no ${k}`);
      assert.equal(typeof dig(es, k), 'string', `locales/es.json has no ${k}`);
    }
  });
});

test('g view: on a module with no catalogue yet it creates locales/en.json and es.json (#366)', async () => {
  await inScratch(async (root) => {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');
    rmSync(join(dir, 'locales'), { recursive: true, force: true });

    await generate('view', 'demo_mod', 'orders');
    assert.ok(existsSync(join(dir, 'locales/en.json')), 'no locales/en.json');
    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'));
    assert.equal(dig(es, 'ui.save'), 'Guardar');
  });
});

test('g module: the create panel fields are boxed, the panel closes on save and the listener is released (#366)', async () => {
  await inScratch(async (root) => {
    await generate('module', 'demo_mod');
    const src = readFileSync(join(root, 'demo_mod', COMP), 'utf8');

    // Every field carries fill="outline" mode="md": without them the hub's ios mode paints no box
    // and `erplora validate` rejects the module (pm#479, module-toolkit#367).
    const inputs = [...src.matchAll(/<ion-input\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(inputs.length >= 2, 'the create form has no fields');
    for (const tag of inputs) {
      assert.match(tag, /\sfill="outline"/, `a field without fill="outline": ${tag}`);
      assert.match(tag, /\smode="md"/, `a field without mode="md": ${tag}`);
    }

    // Saving closes the create panel once the row exists (before reloading the list), and the
    // button tells the user it is saving meanwhile.
    const create = src.slice(src.indexOf('private async create('), src.indexOf('render()'));
    assert.match(create, /this\.dataTable\(\)\?\.close\(\);[\s\S]*await this\.ctrl\.load\(\)/, 'the create panel stays open after saving');
    assert.match(src, /this\.saving \? t\('ui\.saving'\) : t\('ui\.save'\)/, 'the submit button does not show it is saving');

    // The language listener added on connect is removed on disconnect.
    assert.match(src, /removeEventListener\('erplora:locale-changed', this\.onLocaleChange\)/, 'the language listener leaks');
  });
});

test('g view: a catalogue with the developer\'s own keys keeps them all and only gains the view keys (#366)', async () => {
  await inScratch(async (root) => {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');
    // A module whose catalogue was written by hand: its own name, menu and ui keys, none of the view's.
    const own = { name: 'Mi módulo', navigation: { items: { label: 'Artículos' } }, ui: { greeting: 'Hola' } };
    writeFileSync(join(dir, 'locales/es.json'), JSON.stringify(own, null, 2) + '\n');

    await generate('view', 'demo_mod', 'orders');
    const es = JSON.parse(readFileSync(join(dir, 'locales/es.json'), 'utf8'));
    assert.equal(es.name, 'Mi módulo', 'g view dropped the module name');
    assert.equal(dig(es, 'navigation.items.label'), 'Artículos', 'g view dropped the menu entry');
    assert.equal(dig(es, 'ui.greeting'), 'Hola', 'g view dropped a ui key the developer wrote');
    assert.equal(dig(es, 'ui.save'), 'Guardar', 'g view did not bring its own keys');
  });
});
