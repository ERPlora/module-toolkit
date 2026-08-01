#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CANONICAL_URL =
  'https://raw.githubusercontent.com/ERPlora/hub/main/schemas/sql-bridge-functions.json';
const destination = fileURLToPath(
  new URL('../contracts/sql-bridge-functions.json', import.meta.url),
);

const args = process.argv.slice(2);
const check = args.includes('--check');
const sourceIndex = args.indexOf('--source');
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : CANONICAL_URL;
if (!source) throw new Error('--source necesita una ruta o URL');

async function load(value) {
  if (/^https?:\/\//.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`${value}: HTTP ${response.status}`);
    return response.text();
  }
  return readFile(value, 'utf8');
}

function normalize(raw, label) {
  const contract = JSON.parse(raw);
  if (contract.schema_version !== 1 || !Array.isArray(contract.functions)) {
    throw new Error(`${label}: contrato SQL inválido o de versión desconocida`);
  }
  const unique = new Set(contract.functions);
  if (
    unique.size !== contract.functions.length
    || contract.functions.some((name) => !/^erp_[a-z0-9_]+$/.test(name))
  ) {
    throw new Error(`${label}: set de funciones-puente inválido`);
  }
  return `${JSON.stringify(contract, null, 2)}\n`;
}

const canonical = normalize(await load(source), source);
if (check) {
  const local = normalize(await readFile(destination, 'utf8'), destination);
  if (local !== canonical) {
    throw new Error(
      `snapshot SQL desactualizado; ejecuta: node scripts/sync-sql-contract.mjs --source ${source}`,
    );
  }
  console.log(`✓ contrato SQL sincronizado con ${source}`);
} else {
  await writeFile(destination, canonical);
  console.log(`✓ ${destination} actualizado desde ${source}`);
}
