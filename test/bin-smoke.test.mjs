// Smoke test for the CLI entrypoint (#21) — the bin must at least start.
//
// Regression: unescaped backticks inside the usage template literal
// (`bin/erplora.mjs`, `sign` line) broke the whole file with a SyntaxError,
// so EVERY command (`build`, `validate`, `dev`, `pack`…) died on startup.
// These tests spawn the real bin as a subprocess, exactly like a user would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'erplora.mjs');

test('bin/erplora.mjs parses (no SyntaxError)', () => {
  const res = spawnSync(process.execPath, ['--check', BIN], { encoding: 'utf8' });
  assert.equal(res.status, 0, `syntax check failed:\n${res.stderr}`);
});

test('bin/erplora.mjs starts and prints usage for an unknown command', () => {
  const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2, `expected usage exit code 2, got ${res.status}:\n${res.stderr}`);
  assert.match(res.stdout, /uso: erplora <comando>/);
  assert.doesNotMatch(res.stderr, /SyntaxError/);
});
