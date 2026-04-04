#!/usr/bin/env node

/**
 * Agent Olympus SessionStart hook
 *
 * Injects checkpoint recovery prompts and prior learnings into context at the
 * start of each Claude Code session. Never blocks the hook chain: always exits 0.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { readStdin } from './lib/stdin.mjs';
import { queryWisdom } from './lib/wisdom.mjs';
import { loadCheckpoint, formatCheckpoint } from './lib/checkpoint.mjs';
import { runStateCleanup } from './lib/preflight.mjs';
import { registerSession, recoverCrashedSession } from './lib/session-registry.mjs';
import { loadAutonomyConfig } from './lib/autonomy.mjs';

async function main() {
  try {
    const raw = await readStdin(3000);
    // Parse SessionStart event data (cwd may be present for path resolution)
    let _data = {};
    try { _data = JSON.parse(raw); } catch { /* non-fatal */ }

    const sections = [];

    // 0a. Session registry — recover crashed sessions and register current
    try {
      const crashedId = recoverCrashedSession();
      if (crashedId) {
        sections.push(`## Session Recovery\nPrevious session \`${crashedId}\` ended abnormally (crash/kill). Record updated.`);
      }
      const sessionId = _data.session_id || null;
      if (sessionId) {
        registerSession(sessionId, {
          cwd: _data.cwd || process.cwd(),
          transcriptPath: _data.transcript_path || null,
        });
      }
    } catch {
      // session registry failure is non-fatal
    }

    // 0c. State cleanup — clean stale state before loading anything
    // NOTE: capability detection is deferred to first orchestrator call (lazy)
    try {
      const cleanup = await runStateCleanup();
      const parts = [];
      if (cleanup.actions.length > 0) {
        parts.push('Cleanup:\n' + cleanup.actions.map(a => `  ✓ ${a}`).join('\n'));
      }
      if (cleanup.warnings.length > 0) {
        parts.push('Warnings:\n' + cleanup.warnings.map(w => `  ⚠ ${w}`).join('\n'));
      }
      if (parts.length > 0) {
        sections.push(`## State Cleanup\n${parts.join('\n')}`);
      }
    } catch {
      // cleanup failure is non-fatal
    }

    // 0d. Plan execution fallback — check for unhandled plan approval
    // (covers the case where PostToolUse didn't fire due to context-clear)
    try {
      const markerPath = path.join(_data.cwd || process.cwd(), '.ao', 'state', 'ao-plan-pending.json');
      const markerRaw = readFileSync(markerPath, 'utf-8');
      const marker = JSON.parse(markerRaw);
      if (marker && !marker.handled) {
        const config = loadAutonomyConfig(_data.cwd || process.cwd());
        const mode = config.planExecution || 'ask';
        if (mode === 'ask') {
          sections.push(`## Plan Pending\nA plan was approved but execution was not started (session was cleared).\n\n### How would you like to execute?\n1. **Solo** — Execute directly\n2. **Atlas** — Sub-agent orchestrator\n3. **Athena** — Peer-to-peer team\n\nOr say \`/cancel\` to dismiss.`);
        } else if (mode === 'atlas') {
          sections.push(`## Plan Pending\nA plan was approved. Auto-routing to Atlas as configured. Invoke /atlas now.`);
        } else if (mode === 'athena') {
          sections.push(`## Plan Pending\nA plan was approved. Auto-routing to Athena as configured. Invoke /athena now.`);
        }
        // Mark as handled
        try { unlinkSync(markerPath); } catch {}
      }
    } catch {
      // No marker or parse error — normal, no pending plan
    }

    // 1. Checkpoint state — resume interrupted Atlas or Athena sessions
    const atlasCP = await loadCheckpoint('atlas');
    const athenaCP = await loadCheckpoint('athena');
    const cp = atlasCP || athenaCP;
    if (cp) {
      const orchestratorName = cp.orchestrator
        ? cp.orchestrator.charAt(0).toUpperCase() + cp.orchestrator.slice(1)
        : 'Orchestrator';
      sections.push(
        `## Interrupted Session\n${formatCheckpoint(cp)}\nRun /${cp.orchestrator || 'atlas'} or /cancel to resume or clear.`,
      );
    }

    // 2. Prior learnings — medium-confidence or better, most recent 15
    const wisdom = await queryWisdom({ minConfidence: 'medium', limit: 15 });
    if (wisdom.length > 0) {
      // formatWisdomForPrompt adds its own ## header — strip it and re-add
      // to keep section titles consistent with the rest of this hook's output.
      const wisdomBody = wisdom
        .map(e => `- [${e.category}] ${e.lesson}`)
        .join('\n');
      sections.push(`## Prior Learnings\n${wisdomBody}`);
    }

    // 3. Recent git commits (last 5) for orientation
    try {
      const gitLog = execFileSync('git', ['log', '--oneline', '-5'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (gitLog) {
        sections.push(`## Recent Changes\n${gitLog}`);
      }
    } catch {
      // Not a git repo or git unavailable — silently skip
    }

    if (sections.length === 0) {
      process.stdout.write('{}');
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      additionalContext: sections.join('\n\n'),
    }));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
