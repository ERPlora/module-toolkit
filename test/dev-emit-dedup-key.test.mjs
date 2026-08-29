// `erplora dev`'s mock client resolves `commands[].emit` in its object form (ERPlora/hub#1076,
// ERPlora/module-toolkit#133). `node --test`.
//
// `harnessEntry` returns the LITERAL source of the browser bundle (esbuild compiles it as-is) — it
// is not a description evaluated by dev.mjs itself. So the only honest way to prove the preview
// resolves `emit: [{event, dedup_key}]` the same way it always resolved `emit: ["a.b"]` is to run
// that exact generated text, not a parallel reimplementation of what it is supposed to do.
//
// The slice under test is the "Cliente mock" block: a plain in-memory pub/sub with no DOM
// dependency (`listeners`, `emit`, `emitName`, `globalThis.erplora`), so it runs happily inside a
// bare `vm` context — none of the Ionic/`document` wiring below it is needed to prove this bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { harnessEntry } from '../src/dev.mjs';

/** The DOM-free "Cliente mock" slice of the generated harness, ready to `vm.runInContext`. */
function mockClientSource(source) {
  const start = source.indexOf('const MODULES = ');
  const end = source.indexOf('// ── Shell (layout');
  assert.ok(start >= 0 && end > start, 'the harness template moved — update the markers');
  return source.slice(start, end);
}

function buildErplora(manifest) {
  const source = harnessEntry([manifest], {}, [], null);
  const sandbox = { performance };
  vm.createContext(sandbox);
  vm.runInContext(mockClientSource(source), sandbox, { filename: 'harness-mock-client.js' });
  return sandbox.erplora;
}

test('a plain string emit still reaches its listener (no regression)', async () => {
  const manifest = {
    id: 'w1076',
    commands: { 'w1076.thing.legacy': { emit: ['w1076.thing.legacy_done'] } },
  };
  const erplora = buildErplora(manifest);
  const received = [];
  erplora.on('w1076.thing.legacy_done', (payload) => received.push(payload));

  await erplora.command('w1076.thing.legacy', { id: 'row-1' });

  assert.deepEqual(received, [{ id: 'row-1' }]);
});

test('an object emit {event, dedup_key} reaches its listener by `event` (hub#1076 / module-toolkit#133)', async () => {
  const manifest = {
    id: 'w1076',
    commands: {
      'w1076.thing.do': { emit: [{ event: 'w1076.thing.done', dedup_key: 'wa_message_id' }] },
    },
  };
  const erplora = buildErplora(manifest);
  const received = [];
  erplora.on('w1076.thing.done', (payload) => received.push(payload));

  await erplora.command('w1076.thing.do', { wa_message_id: 'm-1' });

  assert.deepEqual(
    received,
    [{ wa_message_id: 'm-1' }],
    'the listener registered for the real event name must fire — before the fix `emit` receives ' +
      'the whole {event, dedup_key} object as its key and no listener ever matches it',
  );
});

test('the inspector lists an object emit by its `event` name, not `[object Object]` (hub#1076 / module-toolkit#133)', () => {
  const manifest = {
    id: 'w1076',
    commands: { 'w1076.thing.do': { emit: [{ event: 'w1076.thing.done', dedup_key: 'wa_message_id' }] } },
  };
  const source = harnessEntry([manifest], {}, [], null);
  assert.match(
    source,
    /flatMap\(\(c\) => c\.emit \|\| \[\]\)\.map\(emitName\)/,
    'the "Eventos (emit)" section must resolve every entry through `emitName` before rendering it',
  );
});
