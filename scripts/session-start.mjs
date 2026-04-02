#!/usr/bin/env node

/**
 * Agent Olympus SessionStart hook
 *
 * Injects checkpoint recovery prompts and prior learnings into context at the
 * start of each Claude Code session. Never blocks the hook chain: always exits 0.
 */

import { execFileSync } from 'node:child_process';
import { readStdin } from './lib/stdin.mjs';
import { queryWisdom } from './lib/wisdom.mjs';
import { loadCheckpoint, formatCheckpoint } from './lib/checkpoint.mjs';
import { runPreflight, formatPreflightReport } from './lib/preflight.mjs';
import { registerSession, recoverCrashedSession } from './lib/session-registry.mjs';

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

    // 0c. Preflight — clean stale state before loading anything
    try {
      const preflightReport = await runPreflight();
      const preflightText = formatPreflightReport(preflightReport);
      if (preflightText) {
        sections.push(`## Preflight\n${preflightText}`);
      }
    } catch {
      // preflight failure is non-fatal
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
