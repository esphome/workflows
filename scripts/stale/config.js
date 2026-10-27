'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function readDays(env, name) {
  const raw = env[name];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readBool(env, name) {
  const raw = env[name];
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
  }
  return raw === 'true';
}

// Build the run configuration from the STALE_* environment variables the
// workflow passes in. `now` is injected so the cutoffs are deterministic.
function readConfig(env, now) {
  const daysBeforeStale = readDays(env, 'STALE_DAYS_BEFORE_STALE');
  const daysBeforeStaleConflicting = readDays(env, 'STALE_DAYS_BEFORE_STALE_CONFLICTING');
  const daysBeforeClose = readDays(env, 'STALE_DAYS_BEFORE_CLOSE');
  const conflictsOnly = readBool(env, 'STALE_CONFLICTS_ONLY');
  const dryRun = readBool(env, 'STALE_DRY_RUN');

  return {
    daysBeforeStale,
    daysBeforeStaleConflicting,
    daysBeforeClose,
    staleLabel: env.STALE_LABEL,
    exemptLabel: env.STALE_EXEMPT_LABEL,
    conflictLabel: env.STALE_CONFLICT_LABEL,
    stalePrMessage: env.STALE_PR_MESSAGE,
    conflictPrMessage: env.STALE_CONFLICT_PR_MESSAGE,
    staleConflictingPrMessage: env.STALE_CONFLICTING_PR_MESSAGE,
    staleIssueMessage: env.STALE_ISSUE_MESSAGE,
    ignoredUsers: new Set((env.STALE_IGNORED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean)),
    conflictsOnly,
    dryRun,
    // The App's own login, to find the conflict reviews it submitted
    botLogin: env.STALE_BOT_LOGIN,
    now,
    staleCutoff: new Date(now.getTime() - daysBeforeStale * DAY_MS),
    closeCutoff: new Date(now.getTime() - daysBeforeClose * DAY_MS),
    conflictCutoff: daysBeforeStaleConflicting > 0
      ? new Date(now.getTime() - daysBeforeStaleConflicting * DAY_MS)
      : null,
  };
}

module.exports = {readConfig};
