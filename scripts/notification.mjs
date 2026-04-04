#!/usr/bin/env node
/**
 * Notification hook — detects idle_prompt and permission_prompt events
 * during autonomous orchestration. Logs notifications for monitoring.
 * Never blocks: always exits 0.
 */

import { readStdin } from './lib/stdin.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATE_DIR = path.join('.ao', 'state');
const NOTIFICATION_LOG = path.join(STATE_DIR, 'ao-notifications.json');

async function main() {
  try {
    const raw = await readStdin(3000);
    let data = {};
    try { data = JSON.parse(raw); } catch { /* non-fatal */ }

    const type = data?.type || data?.matcher || 'unknown';
    const timestamp = new Date().toISOString();

    // Log notification for monitoring by orchestrators
    try {
      await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

      let notifications = [];
      try {
        const existing = await fs.readFile(NOTIFICATION_LOG, 'utf-8');
        notifications = JSON.parse(existing);
      } catch { /* file doesn't exist yet */ }

      // Cap at 50 entries (FIFO)
      notifications.push({ type, timestamp, data: data || {} });
      if (notifications.length > 50) {
        notifications = notifications.slice(-50);
      }

      await fs.writeFile(NOTIFICATION_LOG, JSON.stringify(notifications, null, 2), { mode: 0o600 });
    } catch {
      // Non-critical — logging failure should not affect anything
    }
  } catch {
    // Fail-safe
  }

  process.stdout.write('{}');
  process.exit(0);
}

main();
