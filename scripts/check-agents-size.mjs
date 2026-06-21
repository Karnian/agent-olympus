import { readFileSync } from 'node:fs';

const MAX_BYTES = 28672;
const agentsPath = new URL('../AGENTS.md', import.meta.url);
const byteCount = readFileSync(agentsPath).byteLength;

if (byteCount > MAX_BYTES) {
  process.stderr.write(
    `AGENTS.md is ${byteCount} bytes; maximum is ${MAX_BYTES}. Trim shared instructions or move detail into docs/.\n`,
  );
  process.exit(1);
}
