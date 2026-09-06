// The REAL OutfitKit a hub carries, read from the hub — ERPlora/module-toolkit#203.
//
// WHAT THIS REPLACES. `validate-outfitkit-floor.mjs` used to answer «which OutfitKit does hub
// 1.1.13 carry?» from `HUB_OUTFITKIT`, a table DERIVED BY DATE: «the last `@erplora/outfitkit`
// published on npm before that tag was cut». It is a guess, it has to be extended by hand on every
// hub release, and because it is a guess the control it feeds could only warn — nobody blocks a
// publish on a number somebody worked out from timestamps.
//
// Since ERPlora/hub#1588 the guess is unnecessary: the shell build emits `dist/outfitkit-version.json`,
// the image carries it at `/app/web/outfitkit-version.json`, and the runtime's static layer serves
// it, so any live hub answers `GET /outfitkit-version.json` with `{ "outfitkit": "…", "hub": "…" }`.
//
// 🔴 THE TRAP THAT SHAPES THIS FILE: the hub's static layer has an SPA FALLBACK
// (`with_static_frontend`, `hub/crates/server/src/routes.rs`) — a path with no file on disk returns
// `index.html` with **200 OK**, not a 404. So a hub built BEFORE hub#1588 answers this endpoint
// with a successful page of HTML. A reader that trusts the status code would parse that as «no
// answer» at best and throw at worst; what it must do is recognise it as «this hub does not publish
// the stamp» and degrade to the derived table, out loud and without blocking anybody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CACHE_ENV,
  HUB_STAMP_PATH,
  HUB_URL_ENV,
  cacheFile,
  parseHubStamp,
  readHubOutfitkit,
} from '../src/hub-outfitkit-source.mjs';

/** A throwaway cache path per test: the default one is the developer's `~/.erplora`. */
function tempCache() {
  return join(mkdtempSync(join(tmpdir(), 'erplora-ok-src-')), 'hub-outfitkit.json');
}

/**
 * A hub that answers `GET /outfitkit-version.json` with whatever `reply` says. Real HTTP on a real
 * ephemeral port — the transport is half of what is under test here, so stubbing `fetch` would
 * prove nothing (the SPA-fallback case below is a STATUS 200 with the wrong body).
 */
async function hubServing(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const { status = 200, body = '', type = 'application/json' } = reply(req.url);
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

const stampBody = (outfitkit, hub) => JSON.stringify({ outfitkit, hub });

/** The hub as it is since hub#1588. */
const liveHub = (outfitkit = '0.1.65', hub = '1.1.14') => (path) =>
  path === HUB_STAMP_PATH ? { body: stampBody(outfitkit, hub) } : { status: 404, body: 'no' };

// ── parseHubStamp: what counts as an answer ───────────────────────────────────────────────────

test('parseHubStamp reads the pair the hub build emits', () => {
  assert.deepEqual(parseHubStamp('{"outfitkit":"0.1.65","hub":"1.1.14"}'), {
    hub: '1.1.14',
    outfitkit: '0.1.65',
  });
});

test('parseHubStamp REFUSES the SPA fallback: 200 + index.html is not an answer', () => {
  // The whole reason this function exists instead of `JSON.parse(await res.text()).outfitkit`.
  // A hub older than hub#1588 serves its `index.html` here with a 200.
  assert.equal(parseHubStamp('<!DOCTYPE html>\n<html lang="en"><head><title>ERPlora</title>'), null);
});

test('parseHubStamp refuses an answer that is not the pair, instead of half-believing it', () => {
  for (const body of [
    '{"hub":"1.1.14"}', // no outfitkit
    '{"outfitkit":"0.1.65"}', // no hub: an OutfitKit belonging to no hub resolves no floor
    '{"outfitkit":165,"hub":"1.1.14"}', // a number compares as [165], i.e. newer than everything
    '{"outfitkit":"","hub":"1.1.14"}',
    '{"outfitkit":null,"hub":"1.1.14"}',
    '{"outfitkit":"latest","hub":"1.1.14"}', // not a version: it would sort as 0.0.0
    '{"outfitkit":"0.1.65","hub":"stable"}',
    '[]',
    'null',
    '',
  ]) {
    assert.equal(parseHubStamp(body), null, `${body} must not be taken for a stamp`);
  }
});

test('parseHubStamp keeps a prerelease tail: the comparison already ignores it', () => {
  assert.deepEqual(parseHubStamp('{"outfitkit":"0.1.66-rc.1","hub":"1.1.15"}'), {
    hub: '1.1.15',
    outfitkit: '0.1.66-rc.1',
  });
});

// ── readHubOutfitkit: the live read, and every way it can fail ────────────────────────────────

test('a live hub answers, and the answer is remembered for the next offline run', async () => {
  const hub = await hubServing(liveHub('0.1.65', '1.1.14'));
  const cache = tempCache();
  try {
    const env = { [HUB_URL_ENV]: hub.url, [CACHE_ENV]: cache };
    const live = await readHubOutfitkit({ env });
    assert.deepEqual(live.warnings, [], JSON.stringify(live.warnings));
    assert.equal(live.row.hub, '1.1.14');
    assert.equal(live.row.outfitkit, '0.1.65');
    assert.equal(live.row.origin, 'live');
    assert.deepEqual(hub.seen, [HUB_STAMP_PATH], 'it asks the documented endpoint, once');

    // And the same reading, with the hub gone: this is `erplora validate` on a plane.
    await hub.close();
    const offline = await readHubOutfitkit({ env: { [CACHE_ENV]: cache } });
    assert.equal(offline.row.outfitkit, '0.1.65');
    assert.equal(offline.row.origin, 'cache');
    assert.deepEqual(offline.warnings, [], 'a cache hit with nothing configured is not a failure');
  } finally {
    await hub.close();
  }
});

test('a trailing slash on the configured URL does not double it', async () => {
  const hub = await hubServing(liveHub());
  try {
    const { row } = await readHubOutfitkit({
      env: { [HUB_URL_ENV]: `${hub.url}/`, [CACHE_ENV]: tempCache() },
    });
    assert.equal(row?.origin, 'live');
    assert.deepEqual(hub.seen, [HUB_STAMP_PATH]);
  } finally {
    await hub.close();
  }
});

test('a hub OLDER than hub#1588 degrades LOUDLY: the SPA fallback is not a stamp', async () => {
  // 200 OK + HTML. Nothing throws, nothing is believed, and the author is told why the check is
  // about to be softer than it could be — a degradation nobody sees is how a gate dies quietly.
  const hub = await hubServing(() => ({ body: '<!DOCTYPE html><html>…', type: 'text/html' }));
  try {
    const { row, warnings } = await readHubOutfitkit({
      env: { [HUB_URL_ENV]: hub.url, [CACHE_ENV]: tempCache() },
    });
    assert.equal(row, null);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], new RegExp(hub.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(warnings[0], /hub#1588/, 'it has to say WHY a hub might not answer this');
  } finally {
    await hub.close();
  }
});

test('an HTTP error degrades to a warning, never to an exception', async () => {
  const hub = await hubServing(() => ({ status: 502, body: 'bad gateway' }));
  try {
    const { row, warnings } = await readHubOutfitkit({
      env: { [HUB_URL_ENV]: hub.url, [CACHE_ENV]: tempCache() },
    });
    assert.equal(row, null);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /502/);
  } finally {
    await hub.close();
  }
});

test('an unreachable hub falls back to the cache, and says it is using it', async () => {
  const hub = await hubServing(liveHub('0.1.60', '1.1.13'));
  const cache = tempCache();
  const env = { [HUB_URL_ENV]: hub.url, [CACHE_ENV]: cache };
  await readHubOutfitkit({ env });
  await hub.close();

  const { row, warnings } = await readHubOutfitkit({ env });
  assert.equal(row?.outfitkit, '0.1.60', 'the last real reading is better than a date guess');
  assert.equal(row.origin, 'cache');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /cach/i, 'the author has to know the number is not fresh');
});

test('nothing configured and no cache: silence, not a warning', async () => {
  // `erplora validate` runs on every module PR. A hub URL is opt-in; not opting in is not a fault,
  // and a warning printed on every run of every module is a warning everybody learns to skip.
  const { row, warnings } = await readHubOutfitkit({ env: { [CACHE_ENV]: tempCache() } });
  assert.equal(row, null);
  assert.deepEqual(warnings, []);
});

test('a corrupt cache is ignored, not fatal', async () => {
  const cache = tempCache();
  writeFileSync(cache, '{ not json');
  const { row, warnings } = await readHubOutfitkit({ env: { [CACHE_ENV]: cache } });
  assert.equal(row, null);
  assert.deepEqual(warnings, []);
});

test('a cache written by an older toolkit that no longer parses is ignored, not believed', async () => {
  const cache = tempCache();
  writeFileSync(cache, JSON.stringify({ outfitkit: 165, hub: '1.1.14' }));
  const { row } = await readHubOutfitkit({ env: { [CACHE_ENV]: cache } });
  assert.equal(row, null, 'the cache goes through the same parser as the wire');
});

test('a hub that never answers gives up on the timeout instead of hanging validate', async () => {
  const server = createServer(() => {}); // accepts and never replies
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const started = Date.now();
    const { row, warnings } = await readHubOutfitkit({
      env: { [HUB_URL_ENV]: url, [CACHE_ENV]: tempCache() },
      timeoutMs: 300,
    });
    assert.equal(row, null);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.ok(Date.now() - started < 5000, 'the timeout did not cut the read');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the cache file is written as readable JSON, with where and when it came from', async () => {
  const hub = await hubServing(liveHub('0.1.65', '1.1.14'));
  const cache = tempCache();
  try {
    await readHubOutfitkit({ env: { [HUB_URL_ENV]: hub.url, [CACHE_ENV]: cache } });
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    assert.equal(saved.outfitkit, '0.1.65');
    assert.equal(saved.hub, '1.1.14');
    assert.equal(saved.url, hub.url);
    assert.match(saved.read_at, /^\d{4}-\d{2}-\d{2}T/, 'a number with no date is a number nobody can age out');
  } finally {
    await hub.close();
  }
});

test('cacheFile defaults under the home directory and is overridable', () => {
  assert.match(cacheFile({}), /\.erplora[/\\]hub-outfitkit\.json$/);
  assert.equal(cacheFile({ [CACHE_ENV]: '/tmp/x.json' }), '/tmp/x.json');
});
