/**
 * Autonomy - Ship Policy config loader/validator for Agent Olympus
 *
 * Loads and validates `.ao/autonomy.json`, deep-merges user config over
 * DEFAULT_AUTONOMY_CONFIG, and always returns a usable config. Always fail-safe.
 */

import { readFileSync } from 'fs';
import path from 'path';

/**
 * Default autonomy/ship-policy config used when validation fails or config is absent.
 *
 * @type {{
 *   version: string,
 *   ship: { autoPush: boolean, draftPR: boolean, autoLink: boolean, labels: string[], issuePattern: string },
 *   ci: { watchEnabled: boolean, maxCycles: number, pollIntervalMs: number, timeoutMs: number },
 *   notify: { onComplete: boolean, onBlocked: boolean, onCIFail: boolean, sound: boolean },
 *   budget: { warnThresholdUsd: number | null }
 * }}
 */
export const DEFAULT_AUTONOMY_CONFIG = {
  version: '1',
  ship: {
    autoPush: false,
    draftPR: true,
    autoLink: true,
    labels: [],
    issuePattern: '#(\\d+)',
  },
  ci: {
    watchEnabled: true,
    maxCycles: 2,
    pollIntervalMs: 30000,
    timeoutMs: 600000,
  },
  notify: {
    onComplete: true,
    onBlocked: true,
    onCIFail: true,
    sound: true,
  },
  budget: {
    warnThresholdUsd: null,
  },
  codex: {
    approval: 'auto',
  },
  gemini: {
    approval: 'auto',
  },
  nativeTeams: false,
};

/**
 * Validation result returned by validateAutonomyConfig.
 *
 * @typedef {{ valid: boolean, errors: string[], config: typeof DEFAULT_AUTONOMY_CONFIG }} AutonomyValidationResult
 */

/**
 * Validate the structure of a parsed autonomy config object.
 *
 * Rules checked:
 *   - config must be a non-null object
 *   - ship must be an object with boolean autoPush, draftPR, autoLink; labels array; issuePattern string
 *   - ci.watchEnabled must be boolean
 *   - ci.maxCycles must be a positive integer
 *   - ci.pollIntervalMs must be a positive number
 *   - ci.timeoutMs must be a positive number
 *   - notify.onComplete, notify.onBlocked, notify.onCIFail, notify.sound must be booleans
 *   - budget.warnThresholdUsd must be null or a positive number
 *
 * On any validation error the function returns DEFAULT_AUTONOMY_CONFIG so the
 * caller always receives a usable config regardless of the input.
 *
 * @param {unknown} config - raw parsed config (may be null/undefined on load failure)
 * @returns {AutonomyValidationResult}
 */
export function validateAutonomyConfig(config) {
  try {
    const errors = [];

    // Guard: config must be a non-null object
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      errors.push('config must be a non-null object; received: ' + (config === null ? 'null' : typeof config));
      return { valid: false, errors, config: DEFAULT_AUTONOMY_CONFIG };
    }

    // --- ship ---
    if (!config.ship || typeof config.ship !== 'object' || Array.isArray(config.ship)) {
      errors.push(
        'config.ship must be a non-null object; received: ' +
        (config.ship === null ? 'null' : typeof config.ship)
      );
    } else {
      for (const boolField of ['autoPush', 'draftPR', 'autoLink']) {
        const val = config.ship[boolField];
        if (val !== undefined && typeof val !== 'boolean') {
          errors.push(
            `config.ship.${boolField} must be a boolean; received: ${JSON.stringify(val)}`
          );
        }
      }

      if (config.ship.labels !== undefined && !Array.isArray(config.ship.labels)) {
        errors.push(
          'config.ship.labels must be an array; received: ' + typeof config.ship.labels
        );
      }

      if (config.ship.issuePattern !== undefined && typeof config.ship.issuePattern !== 'string') {
        errors.push(
          'config.ship.issuePattern must be a string; received: ' +
          JSON.stringify(config.ship.issuePattern)
        );
      }
    }

    // --- ci ---
    if (config.ci !== undefined) {
      if (!config.ci || typeof config.ci !== 'object' || Array.isArray(config.ci)) {
        errors.push(
          'config.ci must be a non-null object; received: ' +
          (config.ci === null ? 'null' : typeof config.ci)
        );
      } else {
        // ci.watchEnabled
        if (config.ci.watchEnabled !== undefined && typeof config.ci.watchEnabled !== 'boolean') {
          errors.push(
            'config.ci.watchEnabled must be a boolean; received: ' +
            JSON.stringify(config.ci.watchEnabled)
          );
        }

        // ci.maxCycles — positive integer
        const maxCycles = config.ci.maxCycles;
        if (maxCycles !== undefined) {
          if (
            typeof maxCycles !== 'number' ||
            !Number.isInteger(maxCycles) ||
            maxCycles < 1
          ) {
            errors.push(
              'config.ci.maxCycles must be a positive integer; received: ' +
              JSON.stringify(maxCycles)
            );
          }
        }

        // ci.pollIntervalMs — positive number
        const pollIntervalMs = config.ci.pollIntervalMs;
        if (pollIntervalMs !== undefined) {
          if (typeof pollIntervalMs !== 'number' || pollIntervalMs <= 0) {
            errors.push(
              'config.ci.pollIntervalMs must be a positive number; received: ' +
              JSON.stringify(pollIntervalMs)
            );
          }
        }

        // ci.timeoutMs — positive number
        const timeoutMs = config.ci.timeoutMs;
        if (timeoutMs !== undefined) {
          if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
            errors.push(
              'config.ci.timeoutMs must be a positive number; received: ' +
              JSON.stringify(timeoutMs)
            );
          }
        }
      }
    }

    // --- notify ---
    if (config.notify !== undefined) {
      if (!config.notify || typeof config.notify !== 'object' || Array.isArray(config.notify)) {
        errors.push(
          'config.notify must be a non-null object; received: ' +
          (config.notify === null ? 'null' : typeof config.notify)
        );
      } else {
        for (const boolField of ['onComplete', 'onBlocked', 'onCIFail', 'sound']) {
          const val = config.notify[boolField];
          if (val !== undefined && typeof val !== 'boolean') {
            errors.push(
              `config.notify.${boolField} must be a boolean; received: ${JSON.stringify(val)}`
            );
          }
        }
      }
    }

    // --- budget ---
    if (config.budget !== undefined) {
      if (!config.budget || typeof config.budget !== 'object' || Array.isArray(config.budget)) {
        errors.push(
          'config.budget must be a non-null object; received: ' +
          (config.budget === null ? 'null' : typeof config.budget)
        );
      } else {
        const warnThresholdUsd = config.budget.warnThresholdUsd;
        if (warnThresholdUsd !== undefined && warnThresholdUsd !== null) {
          if (typeof warnThresholdUsd !== 'number' || warnThresholdUsd <= 0) {
            errors.push(
              'config.budget.warnThresholdUsd must be null or a positive number; received: ' +
              JSON.stringify(warnThresholdUsd)
            );
          }
        }
      }
    }

    // --- codex ---
    if (config.codex !== undefined) {
      if (!config.codex || typeof config.codex !== 'object' || Array.isArray(config.codex)) {
        errors.push(
          'config.codex must be a non-null object; received: ' +
          (config.codex === null ? 'null' : typeof config.codex)
        );
      } else {
        const approval = config.codex.approval;
        if (approval !== undefined) {
          const validApprovals = ['auto', 'suggest', 'auto-edit', 'full-auto'];
          if (typeof approval !== 'string' || !validApprovals.includes(approval)) {
            errors.push(
              'config.codex.approval must be one of: auto, suggest, auto-edit, full-auto; received: ' +
              JSON.stringify(approval)
            );
          }
        }
      }
    }

    // --- gemini ---
    if (config.gemini !== undefined) {
      if (!config.gemini || typeof config.gemini !== 'object' || Array.isArray(config.gemini)) {
        errors.push(
          'config.gemini must be a non-null object; received: ' +
          (config.gemini === null ? 'null' : typeof config.gemini)
        );
      } else {
        const approval = config.gemini.approval;
        if (approval !== undefined) {
          const validApprovals = ['auto', 'default', 'auto_edit', 'yolo', 'plan'];
          if (typeof approval !== 'string' || !validApprovals.includes(approval)) {
            errors.push(
              'config.gemini.approval must be one of: auto, default, auto_edit, yolo, plan; received: ' +
              JSON.stringify(approval)
            );
          }
        }
      }
    }

    // --- nativeTeams ---
    if (config.nativeTeams !== undefined && typeof config.nativeTeams !== 'boolean') {
      errors.push(
        'config.nativeTeams must be a boolean; received: ' + JSON.stringify(config.nativeTeams)
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors, config: DEFAULT_AUTONOMY_CONFIG };
    }

    return { valid: true, errors: [], config };
  } catch {
    // fail-safe: never throw
    return {
      valid: false,
      errors: ['validateAutonomyConfig threw an unexpected error; using defaults'],
      config: DEFAULT_AUTONOMY_CONFIG,
    };
  }
}

/**
 * Deep-merge source object into target. Only plain objects are recursed into;
 * arrays and primitives from source overwrite those in target.
 *
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
  const result = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Load and validate the autonomy config from `<cwd>/.ao/autonomy.json`.
 *
 * Reads the file synchronously, parses JSON, deep-merges the user config over
 * DEFAULT_AUTONOMY_CONFIG so partial configs work, then validates the merged
 * result. On a missing file or any error the function silently returns
 * DEFAULT_AUTONOMY_CONFIG — it never throws.
 *
 * @param {string} cwd - project root directory (absolute path)
 * @returns {typeof DEFAULT_AUTONOMY_CONFIG}
 */
export function loadAutonomyConfig(cwd) {
  try {
    const filePath = path.join(cwd, '.ao', 'autonomy.json');
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    // Deep-merge user config over defaults so partial configs are fully hydrated
    const merged = deepMerge(DEFAULT_AUTONOMY_CONFIG, parsed);

    const { config } = validateAutonomyConfig(merged);
    return config;
  } catch {
    // Missing file or any parse/validation error — return safe defaults
    return DEFAULT_AUTONOMY_CONFIG;
  }
}
