// Tests for the `host.notify` channel guard (ERPlora/hub#689). `node --test`.
//
// The contract (ADR-0012) advertises three channels — `email`, `sms`, `whatsapp` — and the JSON
// Schema accepts all three. Only two of them have a transport: the SaaS proxies email and whatsapp
// (ADR-0283 §5) and the hub holds no sms credential of its own, so `Channel::Sms` returns an
// explicit error at send time (`crates/server/src/notify_transport.rs`).
//
// That error is loud, but it fires in PRODUCTION. Until this guard, `erplora validate` did not look
// at `notify` at all: a manifest declaring `sms` packed, signed and published green, and the module
// author found out when a real hub tried to notify a real customer. The guard moves the discovery
// to publish time, which is the only place where it is still cheap.
//
// The check keys on a POSITIVE list of channels that have a transport, not on a hardcoded "sms is
// bad": the day the SaaS proxies sms, one entry moves and the guard is right again — and an
// invented channel (`telegram`) is caught by the same code path instead of slipping through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUPPORTED_NOTIFY_CHANNELS,
  checkNotifyChannels,
} from '../src/validate-notify-channels.mjs';
import { validate } from '../src/validate.mjs';

const mod = (extra) => ({ id: 'reservations', name: 'Reservations', version: '1.0.0', ...extra });

test('PASSES: a module that declares no notify block at all (the shape of most published modules)', () => {
  assert.deepEqual(checkNotifyChannels(mod({})), []);
  assert.deepEqual(checkNotifyChannels(mod({ capabilities: {} })), []);
  assert.deepEqual(checkNotifyChannels(mod({ capabilities: { notify: {} } })), []);
  assert.deepEqual(checkNotifyChannels(mod({ capabilities: { notify: { channels: [] } } })), []);
});

test('PASSES: every channel that actually has a transport today', () => {
  assert.deepEqual(SUPPORTED_NOTIFY_CHANNELS, ['email', 'whatsapp']);
  const errs = checkNotifyChannels(mod({ capabilities: { notify: { channels: ['email', 'whatsapp'] } } }));
  assert.deepEqual(errs, []);
});

test('FAILS: `sms` under capabilities.notify — declared in the contract, no transport behind it', () => {
  const errs = checkNotifyChannels(mod({ capabilities: { notify: { channels: ['email', 'sms'] } } }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /sms/);
  assert.match(errs[0], /capabilities\.notify\.channels/);
  assert.match(errs[0], /hub#689/);
  // The message must say WHY, otherwise the author just deletes the channel and loses the feature.
  assert.match(errs[0], /transporte/i);
});

test('FAILS: `sms` under the LEGACY top-level notify block — the other door of ADR-0012', () => {
  const errs = checkNotifyChannels(mod({ notify: { channels: ['sms'] } }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /notify\.channels/);
  assert.match(errs[0], /sms/);
});

test('FAILS: the same channel declared through BOTH doors is reported once, naming both', () => {
  const errs = checkNotifyChannels(
    mod({ notify: { channels: ['sms'] }, capabilities: { notify: { channels: ['sms'] } } }),
  );
  assert.equal(errs.length, 1, 'one finding per channel, not one per declaration site');
  assert.match(errs[0], /notify\.channels/);
  assert.match(errs[0], /capabilities\.notify\.channels/);
});

test('FAILS: a channel nobody implements is caught by the same positive list', () => {
  const errs = checkNotifyChannels(mod({ capabilities: { notify: { channels: ['telegram'] } } }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /telegram/);
  // An unknown channel is a different mistake from `sms`: say so, do not blame ADR-0012.
  assert.match(errs[0], /desconocido/i);
});

test('FAILS: one finding per offending channel, and the supported ones stay quiet', () => {
  const errs = checkNotifyChannels(
    mod({ capabilities: { notify: { channels: ['email', 'sms', 'telegram', 'whatsapp'] } } }),
  );
  assert.equal(errs.length, 2);
  assert.ok(errs.some((e) => /sms/.test(e)));
  assert.ok(errs.some((e) => /telegram/.test(e)));
});

// The guard is worth nothing unless `erplora validate` runs it: `pack` (and therefore `publish`)
// calls `validate` first, which is what turns this into a PUBLISH gate and not a linter nobody runs.
test('WIRED: `erplora validate` rejects the module, so pack/publish cannot ship it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-notifywire-'));
  writeFileSync(
    join(dir, 'module.json'),
    JSON.stringify({
      id: 'reservations',
      name: 'Reservations',
      version: '1.0.0',
      capabilities: { notify: { channels: ['sms'] } },
    }),
  );
  try {
    await assert.rejects(() => validate(dir), /sms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TOLERATES a malformed block instead of throwing: the JSON Schema owns the shape', () => {
  assert.deepEqual(checkNotifyChannels(mod({ notify: 'sms' })), []);
  assert.deepEqual(checkNotifyChannels(mod({ capabilities: { notify: { channels: 'sms' } } })), []);
  assert.deepEqual(checkNotifyChannels(mod({ capabilities: { notify: { channels: [null, 7] } } })), []);
});
