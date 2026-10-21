'use strict';

const {readConfig} = require('./config');
const {prefetchPulls, waitForMergeability} = require('./pulls');
const {processItem, newCounters} = require('./process');

// Every open PR from the GraphQL prefetch, in the same shape as the REST
// issue list items, newest number first
function pullItems(ctx) {
  return [...ctx.prs.values()]
    .map(node => ({
      number: node.number,
      locked: node.locked,
      labels: node.labels.nodes.map(l => ({name: l.name})),
      pull_request: {},
      // GraphQL drops the [bot] suffix that REST logins carry
      user: node.author && {
        login: node.author.__typename === 'Bot'
          ? `${node.author.login}[bot]` : node.author.login,
      },
      updated_at: node.updatedAt,
      created_at: node.createdAt,
    }))
    .sort((a, b) => b.number - a.number);
}

module.exports = async function run({
  github,
  context,
  core,
  env = process.env,
  now = new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console,
}) {
  const config = readConfig(env, now);
  const {conflictsOnly, conflictCutoff, staleCutoff, closeCutoff, dryRun} = config;

  if (conflictsOnly && !conflictCutoff) {
    core.setFailed('conflicts-only needs days-before-stale-conflicting to be set');
    return null;
  }

  if (conflictsOnly) {
    log.log('Conflicts only: labelling PRs with merge conflicts and ' +
      'unmarking stale ones that are mergeable again');
  } else {
    log.log(`Will mark items without real activity since: ${staleCutoff.toISOString()}`);
    if (conflictCutoff) {
      log.log(`Will mark PRs labelled for merge conflicts before: ${conflictCutoff.toISOString()}`);
    }
    log.log(`Will close items marked stale before: ${closeCutoff.toISOString()}`);
  }

  const ctx = {
    github,
    owner: context.repo.owner,
    repo: context.repo.repo,
    config,
    sleep,
    log,
    // REST pulls.get results by number
    pulls: new Map(),
    // GraphQL prefetch nodes by number
    prs: new Map(),
    prefetchFailed: false,
  };

  await prefetchPulls(ctx);
  if (conflictCutoff) {
    await waitForMergeability(ctx);
  }

  let openItems;
  if (conflictsOnly) {
    if (ctx.prefetchFailed) {
      core.setFailed('conflicts-only needs the GraphQL prefetch, which failed');
      return null;
    }
    openItems = pullItems(ctx);
    log.log(`Processing ${openItems.length} open PRs (conflicts only)`);
  } else {
    openItems = await github.paginate(github.rest.issues.listForRepo, {
      owner: ctx.owner,
      repo: ctx.repo,
      state: 'open',
      per_page: 100,
    });
    log.log(`Processing ${openItems.length} open items`);
  }

  const counters = newCounters();
  for (const item of openItems) {
    try {
      await processItem(ctx, item, counters);
    } catch (e) {
      log.error(`Failed to process #${item.number}: ${e instanceof Error ? e.message : e}`);
    }
  }

  log.log(`Done${dryRun ? ' (dry run)' : ''}: ` +
    `${counters.marked} marked, ${counters.unmarked} unmarked, ${counters.closed} closed, ` +
    `${counters.conflicts} labelled for merge conflicts, ${counters.resolved} conflicts resolved, ` +
    `${counters.unknown} with mergeability not known yet`);
  return counters;
};
