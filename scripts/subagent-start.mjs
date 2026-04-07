#!/usr/bin/env node
/**
 * SubagentStart hook — injects wisdom + design-identity + taste context
 * into spawning subagents via a single-pass loader with a 2.5s wall-clock race.
 *
 * Refactored in v1.0.2 F-001:
 *   - Delegates all I/O to scripts/lib/subagent-context.mjs (loadContextBundle)
 *   - Single wisdom read (not 4 sequential reads)
 *   - Parallel identity + taste reads for design-facing agents
 *   - Hard 2500ms wall-clock cap; timeout → empty additionalContext (fail-safe)
 *   - autonomy.json { subagentContext: { disabled: true } } short-circuits to {}
 *   - Per-loader fail-safe: one bad loader does not poison the others
 *
 * Remains SYNC (non-async) hook per prd.json F-001 AC:
 *   "SubagentStart entry REMAINS SYNC by default (matching existing
 *    context-producing hook pattern). async:true is allowed ONLY after a
 *    compatibility test proves Claude Code still delivers additionalContext
 *    from async SubagentStart hooks."
 *
 * Never blocks: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { loadContextBundle, formatBundle, normalizeAgentName } from './lib/subagent-context.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Agents assigned to haiku-tier models — skip token efficiency directive for these.
const HAIKU_AGENTS = new Set(['explore', 'writer']);

/**
 * Best-effort latency logger — writes a single line to .ao/state/ao-subagent-latency.log.
 * Never throws; suppressOutput from the hook perspective (this is a sidecar file).
 */
async function logLatency(meta, agentName) {
  try {
    const line = JSON.stringify({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      agent: agentName,
      elapsedMs: meta?.elapsedMs,
      timedOut: !!meta?.timedOut,
      errors: meta?.errors || {},
      disabled: !!meta?.disabled,
    }) + '\n';
    const dir = path.join(process.cwd(), '.ao', 'state');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(dir, 'ao-subagent-latency.log'), line, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    /* fail-safe */
  }
}

async function main() {
  let agentName = '';
  try {
    const raw = await readStdin(3000);
    let data = {};
    try { data = JSON.parse(raw); } catch { /* non-fatal */ }

    const subagentType = data?.subagent_type || data?.tool_input?.subagent_type || '';
    agentName = normalizeAgentName(subagentType);

    const bundle = await loadContextBundle({ agentName });

    const isHaiku = HAIKU_AGENTS.has(agentName);
    const formatted = formatBundle(bundle, { includeTokenEfficiency: !isHaiku });

    // Latency log — must await before process.exit so the file actually gets written.
    // Cheap append, never throws (fail-safe wrapper inside).
    await logLatency(bundle.metadata, agentName);

    // Haiku agents with no content → emit {} (match v1.0.1 behavior).
    if (isHaiku && !formatted.trim()) {
      process.stdout.write('{}');
      process.exit(0);
    }

    // Non-haiku agents always get the token efficiency directive (via formatBundle).
    // If even that is empty (shouldn't happen), emit {}.
    if (!formatted.trim()) {
      process.stdout.write('{}');
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({ additionalContext: formatted }));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
