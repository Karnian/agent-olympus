#!/usr/bin/env node

/**
 * Version sync checker — validates all manifests share the same version.
 * Exit 0 if all match, exit 1 with details if mismatch.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function readJsonVersion(relPath) {
  try {
    const content = JSON.parse(readFileSync(join(ROOT, relPath), 'utf-8'));
    return content.version || null;
  } catch {
    return null;
  }
}

function main() {
  // marketplace.json: version lives in metadata.version (not root level)
  let topLevelVersion = null;
  try {
    const mp = JSON.parse(
      readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf-8')
    );
    topLevelVersion = mp?.metadata?.version || mp?.version || null;
  } catch {
    // fall through
  }

  // Also check plugins[0].version in marketplace.json separately
  let pluginsEntryVersion = null;
  try {
    const marketplace = JSON.parse(
      readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf-8')
    );
    pluginsEntryVersion = marketplace?.plugins?.[0]?.version || null;
  } catch {
    // fall through — will be caught as missing below
  }

  const sources = [
    { file: 'package.json', version: readJsonVersion('package.json') },
    { file: '.claude-plugin/plugin.json', version: readJsonVersion('.claude-plugin/plugin.json') },
    { file: '.claude-plugin/marketplace.json (top-level)', version: topLevelVersion },
    { file: '.claude-plugin/marketplace.json (plugins[0])', version: pluginsEntryVersion },
  ];

  const missing = sources.filter(s => !s.version);
  if (missing.length > 0) {
    process.stderr.write(`Missing version in: ${missing.map(s => s.file).join(', ')}\n`);
    process.exit(1);
  }

  const versions = new Set(sources.map(s => s.version));
  if (versions.size === 1) {
    process.stdout.write(`OK: all manifests at v${sources[0].version}\n`);
    process.exit(0);
  }

  process.stderr.write('Version mismatch detected:\n');
  for (const s of sources) {
    process.stderr.write(`  ${s.file}: ${s.version}\n`);
  }
  process.exit(1);
}

main();
