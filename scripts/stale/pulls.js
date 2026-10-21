'use strict';

// Pages are kept small because GitHub aborts a GraphQL request
// after 10 seconds, and each PR's head commit costs about 40ms of
// that. mergeStateStatus is deliberately not requested: at about
// 100ms per PR it alone would push a page past the limit, and
// `CONFLICTING` already means merge conflicts.
const PREFETCH_PAGE = 50;
const PREFETCH_ATTEMPTS = 3;
const PREFETCH_RETRY_MS = 5000;

// GitHub computes mergeability lazily: the first query after the
// base branch moved returns `UNKNOWN` and only starts the merge
// test. The prefetch has already started every test, so
// wait once per round and re-query just the undecided PRs,
// rather than sleeping inside the loop one PR at a time.
const MERGEABILITY_RETRIES = 3;
const MERGEABILITY_RETRY_MS = 10000;
const MERGEABILITY_CHUNK = 100;

function errorMessage(e) {
  return e instanceof Error ? e.message : e;
}

// REST fallback: one pulls.get per PR per run, shared by the
// conflict check and the head-commit lookup. Only used for
// PRs the GraphQL prefetch did not cover
async function getPull(ctx, item) {
  if (!ctx.pulls.has(item.number)) {
    const {data} = await ctx.github.rest.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: item.number,
    });
    ctx.pulls.set(item.number, data);
  }
  return ctx.pulls.get(item.number);
}

// Every open PR is read up front with paged GraphQL queries
// instead of one REST call per PR: the fields the checks
// need (labels, timestamps, the head commit date for the full
// pass and, when conflict handling is on, mergeability) all come
// back in the same response. Anything missing from it falls back
// to the REST paths. On failure the map stays empty and
// everything falls back.
async function prefetchPulls(ctx) {
  const {github, config} = ctx;
  const query = `
    query($owner: String!, $repo: String!, $cursor: String,
          $withMergeable: Boolean!, $withCommits: Boolean!) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: OPEN, first: ${PREFETCH_PAGE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number locked updatedAt createdAt headRefOid
            author { __typename login }
            labels(first: 100) { nodes { name } }
            commits(last: 1) @include(if: $withCommits) {
              nodes { commit { oid committedDate authoredDate } }
            }
            mergeable @include(if: $withMergeable)
          }
        }
      }
    }`;
  // A single page can time out or hit a 502; retry it a few
  // times before giving up on the prefetch
  async function page(cursor) {
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const data = await github.graphql(query, {
          owner: ctx.owner,
          repo: ctx.repo,
          cursor,
          withMergeable: config.conflictCutoff !== null,
          withCommits: !config.conflictsOnly,
        });
        return data.repository.pullRequests;
      } catch (e) {
        if (attempt >= PREFETCH_ATTEMPTS) throw e;
        ctx.log.log(`GraphQL page failed (attempt ${attempt}), retrying: ` +
          `${e instanceof Error ? e.message.split('\n')[0] : e}`);
        await ctx.sleep(PREFETCH_RETRY_MS);
      }
    }
  }
  try {
    let cursor = null;
    do {
      const result = await page(cursor);
      for (const node of result.nodes) ctx.prs.set(node.number, node);
      cursor = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : null;
    } while (cursor);
  } catch (e) {
    ctx.log.error(`GraphQL prefetch failed: ${errorMessage(e)}`);
    ctx.prs.clear();
    ctx.prefetchFailed = true;
  }
}

// true when the PR has merge conflicts, false when it is
// mergeable, null when unknown (not computed yet, or the lookup
// failed). Over REST `dirty` is the only state that means
// conflicts; `behind`, `blocked` and `unstable` do not. GraphQL
// reports the same thing as `CONFLICTING`.
async function hasMergeConflicts(ctx, item) {
  const node = ctx.prs.get(item.number);
  if (node && 'mergeable' in node) {
    if (node.mergeable === 'UNKNOWN') return null;
    return node.mergeable === 'CONFLICTING';
  }
  try {
    const pull = await getPull(ctx, item);
    if (pull.mergeable === null) return null;
    return pull.mergeable === false && pull.mergeable_state === 'dirty';
  } catch (e) {
    ctx.log.error(`Conflict check failed for #${item.number}: ${errorMessage(e)}`);
    return null;
  }
}

async function refreshMergeability(ctx, numbers) {
  const fields = numbers.map(n =>
    `pr${n}: pullRequest(number: ${n}) { number mergeable }`);
  const data = await ctx.github.graphql(
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) { ${fields.join('\n')} }
    }`,
    {owner: ctx.owner, repo: ctx.repo},
  );
  const still = [];
  for (const n of numbers) {
    const fresh = data.repository[`pr${n}`];
    // Gone (deleted or transferred): nothing left to wait for
    if (!fresh) continue;
    const node = ctx.prs.get(n);
    node.mergeable = fresh.mergeable;
    if (fresh.mergeable === 'UNKNOWN') still.push(n);
  }
  return still;
}

async function waitForMergeability(ctx) {
  const {config} = ctx;
  let pending = [...ctx.prs.values()]
    .filter(node => node.mergeable === 'UNKNOWN' && !node.locked &&
      !node.labels.nodes.some(l => l.name === config.exemptLabel))
    .map(node => node.number);
  for (let i = 0; i < MERGEABILITY_RETRIES && pending.length > 0; i++) {
    ctx.log.log(`Waiting for GitHub to compute mergeability of ${pending.length} PRs`);
    await ctx.sleep(MERGEABILITY_RETRY_MS);
    const still = [];
    for (let j = 0; j < pending.length; j += MERGEABILITY_CHUNK) {
      const chunk = pending.slice(j, j + MERGEABILITY_CHUNK);
      try {
        still.push(...await refreshMergeability(ctx, chunk));
      } catch (e) {
        ctx.log.error(`Mergeability lookup failed for ${chunk.length} PRs: ` +
          `${errorMessage(e)}`);
        // Keep them pending so a transient error is retried
        still.push(...chunk);
      }
    }
    pending = still;
  }
}

// The date of the PR's head commit, or undefined when it has none. The
// head SHA of a fork PR is reachable through the base repository (GitHub
// keeps refs/pull/N/head there), so the base-repo commit API is correct
// for fork PRs too. Throws on lookup failure; callers isolate that.
async function headCommitDate(ctx, item) {
  // The prefetch already carries the head commit; use it
  // only when it is the head the PR points at right now
  const node = ctx.prs.get(item.number);
  const headCommit = node?.commits?.nodes[0]?.commit;
  if (headCommit && headCommit.oid === node.headRefOid) {
    return headCommit.committedDate ?? headCommit.authoredDate;
  }
  const pull = await getPull(ctx, item);
  const {data: head} = await ctx.github.rest.repos.getCommit({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: pull.head.sha,
  });
  return head.commit?.committer?.date ?? head.commit?.author?.date;
}

module.exports = {
  getPull,
  prefetchPulls,
  hasMergeConflicts,
  refreshMergeability,
  waitForMergeability,
  headCommitDate,
};
