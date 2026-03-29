/**
 * Changelog utilities for agent-olympus orchestrators.
 *
 * Generates and prepends Keep a Changelog formatted entries to CHANGELOG.md.
 * Format mirrors the existing repo changelog: ## [version] - date, then
 * ### Added section listing completed user stories.
 *
 * Zero npm dependencies — uses fs built-in only.
 */

import { readFileSync, writeFileSync } from 'fs';

/**
 * @typedef {object} UserStory
 * @property {string}  id     - Story identifier (e.g. "US-1")
 * @property {string}  title  - Story title
 * @property {boolean} passes - Whether the story passed acceptance criteria
 */

/**
 * @typedef {object} PRD
 * @property {UserStory[]} userStories - Array of user stories
 */

/**
 * Generate a Keep a Changelog formatted entry string.
 *
 * Only stories where `passes === true` are included in the "### Added" list.
 * If no stories pass, the "### Added" section is omitted.
 *
 * @param {object} options
 * @param {PRD}    options.prd     - PRD object with userStories array
 * @param {string} options.version - Semantic version string (e.g. "0.8.0")
 * @param {string} options.date    - ISO date string (e.g. "2026-03-30")
 * @returns {string} Formatted changelog entry (no trailing newline)
 */
export function generateChangelogEntry({ prd, version, date }) {
  const header = `## [${version}] - ${date}`;

  const stories = Array.isArray(prd?.userStories) ? prd.userStories : [];
  const passed  = stories.filter(s => s.passes === true);

  if (passed.length === 0) {
    return header;
  }

  const lines = [`### Added`];
  for (const story of passed) {
    // Use id + title when both are present, otherwise fall back to whichever exists
    const label = story.id && story.title
      ? `**${story.id}** — ${story.title}`
      : story.title || story.id || 'Untitled story';
    lines.push(`- ${label}`);
  }

  return `${header}\n\n${lines.join('\n')}`;
}

/**
 * Prepend a changelog entry to an existing CHANGELOG.md file.
 *
 * The entry is inserted immediately before the first "## " version heading so
 * that the "# Changelog" title line (and any blank lines after it) are
 * preserved. The result is written back atomically via writeFileSync.
 *
 * If the file does not exist, it is created with a standard header followed
 * by the new entry.
 *
 * @param {string} filePath - Absolute path to the CHANGELOG.md file
 * @param {string} entry    - Formatted entry string from generateChangelogEntry
 * @returns {void}
 */
export function prependToChangelog(filePath, entry) {
  let existing;
  try {
    existing = readFileSync(filePath, 'utf8');
  } catch {
    // File does not exist — create it from scratch
    writeFileSync(filePath, `# Changelog\n\n${entry}\n`, { encoding: 'utf8' });
    return;
  }

  const lines = existing.split('\n');

  // Find the index of the first line that starts with "## " (first version entry)
  const insertIndex = lines.findIndex(line => line.startsWith('## '));

  if (insertIndex === -1) {
    // No existing version entry — append after whatever is already there
    const trimmed = existing.trimEnd();
    writeFileSync(filePath, `${trimmed}\n\n${entry}\n`, { encoding: 'utf8' });
    return;
  }

  // Insert the new entry + blank line before the first "## " line
  lines.splice(insertIndex, 0, ...`${entry}\n`.split('\n'));

  writeFileSync(filePath, lines.join('\n'), { encoding: 'utf8' });
}
