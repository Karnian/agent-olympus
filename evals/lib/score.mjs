/**
 * Score helpers for eval harness task trials.
 *
 * @typedef {object} TrialResult
 * @property {boolean} [pass] Whether a single trial passed.
 *
 * @typedef {object} TaskResult
 * @property {string} track Track name, usually "regression" or "capability".
 * @property {boolean} [pass] Whether the task/trial passed.
 * @property {boolean} [passHatK] Whether all trials for the task passed.
 *
 * @typedef {object} TrackRollup
 * @property {string} track Track name.
 * @property {number} total Number of task results in the track.
 * @property {number} passed Number of task results that passed.
 */

/**
 * Return true when at least one trial passed.
 *
 * Empty input is explicitly false: there is no successful trial to count.
 *
 * @param {TrialResult[]} results Trial results.
 * @returns {boolean}
 */
export function passAtK(results) {
  const items = Array.isArray(results) ? results : [];
  return items.length > 0 && items.some((result) => Boolean(result?.pass));
}

/**
 * Return true when every trial passed.
 *
 * Empty input is explicitly false: vacuous truth would overstate reliability.
 *
 * @param {TrialResult[]} results Trial results.
 * @returns {boolean}
 */
export function passHatK(results) {
  const items = Array.isArray(results) ? results : [];
  return items.length > 0 && items.every((result) => Boolean(result?.pass));
}

/**
 * Count total and passed task results by track.
 *
 * For task summaries, `passHatK` is the verdict. For raw trial rows, `pass`
 * is the verdict. If both are present, `pass` wins so an explicit trial
 * failure is not masked by a summary field.
 *
 * @param {TaskResult[]} taskResults Task summaries or trial rows.
 * @returns {TrackRollup[]}
 */
export function rollupByTrack(taskResults) {
  const rollups = new Map();
  const items = Array.isArray(taskResults) ? taskResults : [];

  for (const result of items) {
    const track = String(result?.track ?? 'unknown');
    if (!rollups.has(track)) {
      rollups.set(track, { track, total: 0, passed: 0 });
    }

    const rollup = rollups.get(track);
    rollup.total += 1;
    if (Boolean(result?.pass ?? result?.passHatK)) {
      rollup.passed += 1;
    }
  }

  return Array.from(rollups.values());
}
