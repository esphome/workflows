'use strict';

async function removeLabel(ctx, item, name) {
  await ctx.github.rest.issues.removeLabel({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: item.number,
    name,
  });
}

async function addLabel(ctx, item, name) {
  await ctx.github.rest.issues.addLabels({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: item.number,
    labels: [name],
  });
}

async function markStale(ctx, item, body) {
  // Comment before labeling: if the comment fails the item is
  // retried next run, instead of a labeled-but-unwarned item
  // being closed later without explanation
  await ctx.github.rest.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: item.number,
    body,
  });
  await addLabel(ctx, item, ctx.config.staleLabel);
}

// A request-changes review, so a conflicting PR shows as blocked
// in the PR list. GitHub refuses one on the App's own PRs, so
// those get a plain comment instead.
async function requestConflictChanges(ctx, item) {
  if (item.user?.login === ctx.config.botLogin) {
    await ctx.github.rest.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: item.number,
      body: ctx.config.conflictPrMessage,
    });
    return;
  }
  await ctx.github.rest.pulls.createReview({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: item.number,
    event: 'REQUEST_CHANGES',
    body: ctx.config.conflictPrMessage,
  });
}

// Dismiss the reviews requestConflictChanges submitted, so a PR
// is not left blocked once it is mergeable. Called before the
// conflict label is removed: if a dismissal fails the PR keeps
// the label and is retried next run, rather than keeping the
// review forever.
async function dismissConflictReviews(ctx, item) {
  const reviews = await ctx.github.paginate(ctx.github.rest.pulls.listReviews, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: item.number,
    per_page: 100,
  });
  for (const review of reviews) {
    if (review.user?.login !== ctx.config.botLogin || review.state !== 'CHANGES_REQUESTED') continue;
    await ctx.github.rest.pulls.dismissReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: item.number,
      review_id: review.id,
      message: 'The merge conflicts have been resolved.',
    });
  }
}

async function closeItem(ctx, item, isPr) {
  const update = {
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: item.number,
    state: 'closed',
  };
  // Issues support a close reason; PRs do not
  if (!isPr) {
    update.state_reason = 'not_planned';
  }
  await ctx.github.rest.issues.update(update);
}

module.exports = {
  removeLabel,
  addLabel,
  markStale,
  requestConflictChanges,
  dismissConflictReviews,
  closeItem,
};
