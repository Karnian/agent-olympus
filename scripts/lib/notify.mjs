/**
 * Desktop notification utilities for agent-olympus orchestrators.
 * OS-aware: macOS (osascript), Linux (notify-send), fallback (terminal bell).
 * Zero npm dependencies — uses child_process only.
 *
 * Usage from Node:
 *   import { notify } from './notify.mjs';
 *   notify({ title: 'Atlas Complete', body: '5/5 stories passed' });
 *
 * Usage from CLI (called by orchestrator skills via Bash tool):
 *   node scripts/notify-cli.mjs --title "Atlas" --body "Done" --sound
 */

import { execFileSync } from 'child_process';
import { platform } from 'os';

/**
 * Detect notification backend based on OS.
 * @returns {'macos' | 'linux' | 'fallback'}
 */
export function detectPlatform() {
  const os = platform();
  if (os === 'darwin') return 'macos';
  if (os === 'linux') return 'linux';
  return 'fallback';
}

/**
 * Sanitize a string for safe inclusion in osascript AppleScript.
 * Escapes backslashes and double-quotes.
 * @param {string} str
 * @returns {string}
 */
function escapeAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Send a desktop notification.
 * Fail-safe: never throws — logs to stderr on error.
 *
 * @param {object} options
 * @param {string} options.title   - Notification title (e.g. "Atlas Complete")
 * @param {string} options.body    - Notification body text
 * @param {boolean} [options.sound=false] - Play system notification sound (macOS only)
 * @returns {boolean} true if notification was sent, false on fallback/error
 */
export function notify({ title, body, sound = false }) {
  try {
    const plat = detectPlatform();

    if (plat === 'macos') {
      const soundClause = sound ? ' sound name "Ping"' : '';
      const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"${soundClause}`;
      execFileSync('osascript', ['-e', script], { timeout: 5000, stdio: 'ignore' });
      return true;
    }

    if (plat === 'linux') {
      execFileSync('notify-send', [title, body, '--expire-time=10000'], {
        timeout: 5000,
        stdio: 'ignore',
      });
      return true;
    }

    // Fallback: terminal bell + stderr message
    process.stderr.write(`\x07\n[agent-olympus] ${title}: ${body}\n`);
    return false;
  } catch {
    // Fail-safe: never crash the orchestrator over a notification
    try {
      process.stderr.write(`\x07\n[agent-olympus] ${title}: ${body}\n`);
    } catch {}
    return false;
  }
}

/**
 * Pre-formatted notification for orchestrator lifecycle events.
 *
 * @param {object} options
 * @param {'complete' | 'blocked' | 'escalated' | 'ci_failed' | 'ci_passed'} options.event
 * @param {string} options.orchestrator - 'atlas' | 'athena'
 * @param {string} [options.summary]    - Short summary text
 * @param {number} [options.completed]  - Number of stories completed
 * @param {number} [options.total]      - Total number of stories
 * @returns {boolean}
 */
export function notifyOrchestrator({ event, orchestrator, summary, completed, total }) {
  const name = orchestrator === 'athena' ? 'Athena' : 'Atlas';

  const templates = {
    complete: {
      title: `${name} Complete`,
      body: completed != null && total != null
        ? `${completed}/${total} stories passed. ${summary || 'Ready for review.'}`
        : summary || 'Task completed successfully.',
      sound: true,
    },
    done: {
      title: `${name} Complete`,
      body: summary || 'Task completed successfully.',
      sound: true,
    },
    blocked: {
      title: `${name} Blocked`,
      body: summary || 'User input required.',
      sound: true,
    },
    escalated: {
      title: `${name} Escalated`,
      body: summary || 'Max retries reached. Manual intervention needed.',
      sound: true,
    },
    ci_failed: {
      title: `${name} — CI Failed`,
      body: summary || 'CI checks failed after PR creation.',
      sound: false,
    },
    ci_passed: {
      title: `${name} — CI Passed`,
      body: summary || 'All CI checks passed.',
      sound: true,
    },
    started: {
      title: `${name} Started`,
      body: summary || 'Orchestrator started.',
      sound: false,
    },
    progress: {
      title: `${name} Progress`,
      body: summary || 'Work in progress.',
      sound: false,
    },
  };

  const tmpl = templates[event] || {
    title: `${name} — ${String(event || 'Notification').replace(/_/g, ' ')}`,
    body: summary || 'Task update.',
    sound: false,
  };
  return notify(tmpl);
}
