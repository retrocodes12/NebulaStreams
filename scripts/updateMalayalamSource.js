#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const input = String(process.argv[2] || '').trim();

if (!input) {
  console.error('Usage: node scripts/updateMalayalamSource.js <url>');
  process.exit(1);
}

const normalizeMalayalamUrl = (value) => {
  const trimmed = String(value || '').trim();
  const okMatch = trimmed.match(/^https?:\/\/(?:www\.)?ok\.ru\/video(?:embed)?\/(\d+)(?:[/?#].*)?$/u);
  if (okMatch) {
    return `https://ok.ru/videoembed/${okMatch[1]}`;
  }
  return trimmed;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(repoRoot, 'src/adapters/StreamedSportsAdapter.js');
const source = readFileSync(adapterPath, 'utf8');
const newUrl = normalizeMalayalamUrl(input);

const blockPattern = /(\{\s*id:\s*'l7',\s*streamNo:\s*7,\s*language:\s*'Malayalam',\s*hd:\s*true,\s*embedUrl:\s*')([^']+)(')/u;
const match = source.match(blockPattern);

if (!match) {
  console.error('Malayalam source block not found.');
  process.exit(1);
}

const oldUrl = match[2];

if (oldUrl === newUrl) {
  console.log(`Malayalam source already set: ${newUrl}`);
  process.exit(0);
}

const next = source.replace(blockPattern, `$1${newUrl}$3`);
writeFileSync(adapterPath, next);
console.log(`Malayalam source updated: ${oldUrl} -> ${newUrl}`);
