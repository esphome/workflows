'use strict';

const {headCommitDate} = require('./pulls');

// The GitHub updated_at timestamp moves on events that are not
// real activity: bots editing their comments in place, label
// changes and similar housekeeping. Real activity is therefore
// measured directly: comments *created* by users, and for PRs
// also commits and review submissions. Since every kind of real
// activity also bumps updated_at, the timestamp is an upper
// bound: an item whose updated_at is old is conclusively
// inactive, and only apparently-fresh items need verification.
async function hasRealActivitySince(ctx, item, since) {
  const {github} = ctx;
  // Note: the `since` filter of listComments matches the comment
  // updated_at, so an edited old comment reappears here; compare
  // created_at to only count genuinely new comments.
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: item.number,
    since: since.toISOString(),
    per_page: 100,
  });
  const isRealUser = u => u?.type === 'User' && !ctx.config.ignoredUsers.has(u.login);
  if (comments.some(c => isRealUser(c.user) && new Date(c.created_at) >= since)) {
    return true;
  }

  if ('pull_request' in item) {
    // Isolated so an unexpected lookup failure falls through to the
    // review check instead of skipping the whole item
    try {
      const lastCommitDate = await headCommitDate(ctx, item);
      if (lastCommitDate && new Date(lastCommitDate) >= since) {
        return true;
      }
    } catch (e) {
      ctx.log.error(`Commit check failed for #${item.number}: ${e instanceof Error ? e.message : e}`);
    }

    const reviews = await github.paginate(github.rest.pulls.listReviews, {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: item.number,
      per_page: 100,
    });
    if (reviews.some(r => isRealUser(r.user) && r.submitted_at && new Date(r.submitted_at) >= since)) {
      return true;
    }
  }

  return false;
}

async function labelDate(ctx, item, name) {
  const events = await ctx.github.paginate(ctx.github.rest.issues.listEvents, {
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: item.number,
    per_page: 100,
  });
  const labelings = events.filter(e => e.event === 'labeled' && e.label?.name === name);
  const last = labelings[labelings.length - 1];
  return last ? new Date(last.created_at) : null;
}

module.exports = {hasRealActivitySince, labelDate};
