'use strict';

const {hasMergeConflicts} = require('./pulls');
const {hasRealActivitySince, labelDate} = require('./activity');
const {
  removeLabel,
  addLabel,
  markStale,
  requestConflictChanges,
  dismissConflictReviews,
  closeItem,
} = require('./actions');

function newCounters() {
  return {marked: 0, unmarked: 0, closed: 0, conflicts: 0, resolved: 0, unknown: 0};
}

// Decide and apply what happens to one open item, updating `counters`.
// Errors propagate to the caller, which logs them per item.
async function processItem(ctx, item, counters) {
  const {config, log} = ctx;
  if (item.locked) return;
  const labels = item.labels.map(l => l.name);
  if (labels.includes(config.exemptLabel)) return;

  const isPr = 'pull_request' in item;
  const updatedAt = new Date(item.updated_at);
  const createdAt = new Date(item.created_at);
  const {conflictsOnly, dryRun, conflictCutoff, staleCutoff, closeCutoff} = config;

  if (labels.includes(config.staleLabel)) {
    // Already stale: real activity unmarks, silence closes
    // (conflicts-only never looks at the stale age)
    const labeledAt = conflictsOnly ? null : await labelDate(ctx, item, config.staleLabel);
    if (!conflictsOnly && !labeledAt) {
      log.warn(`No ${config.staleLabel} labeling event found for #${item.number}; skipping`);
      return;
    }

    // Stale with the conflict label: a comment does not keep
    // it open, only resolving the conflicts does, and doing so
    // clears both labels as the conflict comment promised.
    let rescued = true;
    if (isPr && conflictCutoff && labels.includes(config.conflictLabel)) {
      const conflicting = await hasMergeConflicts(ctx, item);
      if (conflicting === null) {
        log.log(`Skipping PR #${item.number}: mergeability not known yet`);
        counters.unknown++;
        return;
      }
      if (conflicting) {
        rescued = false;
      } else {
        log.log(`Unmarking PR #${item.number}: mergeable again`);
        if (!dryRun) {
          await dismissConflictReviews(ctx, item);
          await removeLabel(ctx, item, config.conflictLabel);
          await removeLabel(ctx, item, config.staleLabel);
        }
        counters.resolved++;
        counters.unmarked++;
        return;
      }
    }

    if (conflictsOnly) return;

    // Measure from whichever is later, so activity that is
    // itself older than the stale window cannot clear the label
    // on an item that was marked long ago.
    const since = labeledAt > staleCutoff ? labeledAt : staleCutoff;
    if (rescued && await hasRealActivitySince(ctx, item, since)) {
      const kind = isPr ? 'PR' : 'issue';
      log.log(`Unmarking ${kind} #${item.number}: real activity since it was marked stale`);
      if (!dryRun) {
        await removeLabel(ctx, item, config.staleLabel);
      }
      counters.unmarked++;
    } else if (labeledAt < closeCutoff) {
      const kind = isPr ? 'PR' : 'issue';
      const reason = rescued ? 'no real activity' : 'merge conflicts unresolved';
      log.log(`Closing ${kind} #${item.number}: ` +
        `${reason} since stale on ${labeledAt.toISOString()}`);
      if (!dryRun) {
        await closeItem(ctx, item, isPr);
      }
      counters.closed++;
    }
    return;
  }

  // Not stale yet. Merge conflicts are handled first: a PR
  // is labelled and told the moment they appear, and marked
  // stale once the label is old enough with the conflicts
  // still unresolved, whatever else happened on it meanwhile.
  // A conflict still inside its window falls through to the
  // inactivity check like any other PR.
  let labelled = isPr && labels.includes(config.conflictLabel);
  if (isPr && conflictCutoff) {
    const conflicting = await hasMergeConflicts(ctx, item);
    if (conflicting === null) {
      log.log(`PR #${item.number}: mergeability not known yet`);
      counters.unknown++;
    }
    if (conflicting === true && !labelled) {
      log.log(`Labelling PR #${item.number} for merge conflicts`);
      if (!dryRun) {
        // Review before labeling, so a failed review is
        // retried next run
        await requestConflictChanges(ctx, item);
        await addLabel(ctx, item, config.conflictLabel);
      }
      counters.conflicts++;
      return;
    }
    if (conflicting === false && labelled) {
      log.log(`PR #${item.number} is mergeable again; removing ${config.conflictLabel}`);
      if (!dryRun) {
        await dismissConflictReviews(ctx, item);
        await removeLabel(ctx, item, config.conflictLabel);
      }
      counters.resolved++;
      labelled = false;
    }
    if (conflicting === true && labelled && !conflictsOnly) {
      const conflictLabeledAt = await labelDate(ctx, item, config.conflictLabel);
      if (conflictLabeledAt && conflictLabeledAt < conflictCutoff) {
        log.log(`Marking PR #${item.number} as stale: ` +
          `merge conflicts unresolved since ${conflictLabeledAt.toISOString()}`);
        if (!dryRun) {
          await markStale(ctx, item, config.staleConflictingPrMessage);
        }
        counters.marked++;
        return;
      }
    }
  }

  if (conflictsOnly) return;

  // An old updated_at is conclusive; a fresh one may be a
  // phantom update and needs verification, but only for items
  // old enough to possibly be inactive.
  if (updatedAt >= staleCutoff && createdAt >= staleCutoff) return;
  if (updatedAt >= staleCutoff && await hasRealActivitySince(ctx, item, staleCutoff)) return;

  // A PR carrying the conflict label is told so, since a
  // comment will not keep it open once it is stale
  const kind = isPr ? 'PR' : 'issue';
  log.log(`Marking ${kind} #${item.number} as stale: ` +
    `no real activity since ${staleCutoff.toISOString()} (updated_at ${item.updated_at})`);
  if (!dryRun) {
    const message = !isPr ? config.staleIssueMessage
      : conflictCutoff && labelled ? config.staleConflictingPrMessage
      : config.stalePrMessage;
    await markStale(ctx, item, message);
  }
  counters.marked++;
}

module.exports = {processItem, newCounters};
