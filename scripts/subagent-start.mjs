#!/usr/bin/env node
/**
 * SubagentStart hook — injects wisdom context into spawning subagents.
 * Reads recent learnings from .ao/wisdom.jsonl and provides them as additionalContext.
 * Filters wisdom by relevant categories when the subagent type is known.
 * Never blocks: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { queryWisdom, formatWisdomForPrompt } from './lib/wisdom.mjs';

async function main() {
  try {
    const raw = await readStdin(3000);
    let data = {};
    try { data = JSON.parse(raw); } catch { /* non-fatal */ }

    // Extract subagent type for wisdom filtering
    const subagentType = data?.subagent_type || data?.tool_input?.subagent_type || '';
    const agentName = subagentType.replace('agent-olympus:', '');

    // Map agent names to relevant wisdom categories
    const categoryMap = {
      'test-engineer': ['test', 'build', 'debug'],
      'debugger': ['debug', 'build', 'test'],
      'designer': ['pattern', 'architecture'],
      'architect': ['architecture', 'pattern'],
      'security-reviewer': ['debug', 'architecture'],
      'code-reviewer': ['pattern', 'architecture', 'debug'],
      'executor': ['pattern', 'build', 'debug'],
      'writer': ['general'],
      'explore': ['architecture', 'pattern'],
    };

    const relevantCategories = categoryMap[agentName] || null;

    // Query wisdom — filter by categories if known agent, otherwise get all
    let entries;
    if (relevantCategories) {
      // Get entries from each relevant category, deduplicate
      const seen = new Set();
      entries = [];
      for (const cat of relevantCategories) {
        const catEntries = await queryWisdom({ category: cat, limit: 5 });
        for (const e of (catEntries || [])) {
          const key = e.lesson || e.text || '';
          if (!seen.has(key)) {
            seen.add(key);
            entries.push(e);
          }
        }
      }
      // Also include recent high-confidence entries regardless of category
      const recentHigh = await queryWisdom({ minConfidence: 'high', limit: 3 });
      for (const e of (recentHigh || [])) {
        const key = e.lesson || e.text || '';
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(e);
        }
      }
    } else {
      entries = await queryWisdom({ minConfidence: 'medium', limit: 10 });
    }

    if (!entries || entries.length === 0) {
      process.stdout.write('{}');
      process.exit(0);
    }

    const wisdomContext = formatWisdomForPrompt(entries);
    if (!wisdomContext.trim()) {
      process.stdout.write('{}');
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      additionalContext: wisdomContext,
    }));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}

main();
