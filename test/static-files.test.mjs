import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

function moduleDir(staticFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-static-files-'));
  writeFileSync(
    join(dir, 'module.json'),
    JSON.stringify({
      id: 'verifactu',
      name: 'VeriFactu',
      version: '1.0.0',
      static_files: staticFiles,
    }),
  );
  return dir;
}

test('validate accepts one safe static_files folder', async (t) => {
  const dir = moduleDir({ folder: 'verifactu' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeContractsFile(dir, JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')));
  await assert.doesNotReject(validate(dir));
});

test('validate rejects paths in static_files.folder', async (t) => {
  const dir = moduleDir({ folder: '../verifactu' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(validate(dir), /static_files\.folder inválido/);
});
