import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const TEAMS_DIR = '.ao/teams';

/** Valid phase values and their display indicators. */
const PHASE_INDICATORS = {
  done:         '✓',
  testing:      '⧗',
  implementing: '▶',
  planning:     '◎',
  blocked:      '⚠',
  failed:       '✗',
  reviewing:    '↺',
};

/**
 * Format a UTC ISO timestamp as a human-readable age string ("Xs ago", "Xm ago", "Xh ago").
 * @param {string} isoTimestamp
 * @returns {string}
 */
function formatAge(isoTimestamp) {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

/**
 * Append a status record for a worker to the team's status.jsonl file.
 * @param {string} teamName
 * @param {string} workerName
 * @param {string} phase - one of: planning|implementing|testing|reviewing|done|blocked|failed
 * @param {string} progress - short free-text progress description
 */
export function reportWorkerStatus(teamName, workerName, phase, progress) {
  try {
    const dir = join(TEAMS_DIR, teamName);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const record = {
      timestamp: new Date().toISOString(),
      worker: workerName,
      phase,
      progress,
    };

    appendFileSync(
      join(dir, 'status.jsonl'),
      JSON.stringify(record) + '\n',
      { encoding: 'utf-8', mode: 0o600 }
    );
  } catch {}
}

/**
 * Read status.jsonl for a team and return a Map of worker → latest status record.
 * @param {string} teamName
 * @returns {Map<string, { timestamp: string, worker: string, phase: string, progress: string }>}
 */
export function readTeamStatus(teamName) {
  try {
    const filePath = join(TEAMS_DIR, teamName, 'status.jsonl');
    if (!existsSync(filePath)) return new Map();

    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const latest = new Map();

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        // Later lines overwrite earlier ones — last entry per worker wins
        latest.set(record.worker, record);
      } catch {}
    }

    return latest;
  } catch {
    return new Map();
  }
}

/**
 * Return a markdown table string showing the current status of all workers in a team.
 * @param {string} teamName
 * @returns {string}
 */
export function formatStatusMarkdown(teamName) {
  try {
    const statusMap = readTeamStatus(teamName);
    if (statusMap.size === 0) return '';

    const now = new Date();
    const hms = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join(':');

    const header = [
      `## Athena Team Status (${hms})`,
      '| Worker | Phase | Progress | Updated |',
      '|--------|-------|----------|---------|',
    ];

    const rows = [];
    for (const [worker, record] of statusMap) {
      const indicator = PHASE_INDICATORS[record.phase] ?? '';
      const phase = `${indicator} ${record.phase}`.trim();
      const age = formatAge(record.timestamp);
      rows.push(`| ${worker} | ${phase} | ${record.progress} | ${age} |`);
    }

    return [...header, ...rows].join('\n');
  } catch {
    return '';
  }
}

/**
 * Delete the team's status.jsonl file (call on team completion).
 * @param {string} teamName
 */
export function clearTeamStatus(teamName) {
  try {
    const filePath = join(TEAMS_DIR, teamName, 'status.jsonl');
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {}
}
