// Requests a Copilot code review on pull requests. A failed request only
// warns: Copilot review is advisory and must never block the PR.
//
// GitHub answers a request it will not act on (one made by an identity without
// a Copilot seat, which includes GITHUB_TOKEN and GitHub Apps when the PR
// author has no Copilot access) with a success and no review, so the timeline
// is read back to confirm the request was recorded.

const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";
// The timeline names the reviewer by its display login; the reviews API uses
// the bot account.
const COPILOT_LOGINS = new Set(["Copilot", COPILOT_REVIEWER]);

// Which open pull requests should this run look at? The caller was started by
// the "PR event" doorbell (workflow_run), the hourly sweep (schedule) or by
// hand (workflow_dispatch).
async function findPullRequests({ github, context, prNumber }) {
  if (context.eventName === "workflow_dispatch") return [Number(prNumber)];
  const open = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  if (context.eventName === "workflow_run") {
    // A fork's run does not name its pull request, so match the head
    // repository and the exact commit.
    const run = context.payload.workflow_run;
    return open
      .filter(
        (pr) =>
          pr.head.sha === run.head_sha &&
          pr.head.repo?.id === run.head_repository.id
      )
      .map((pr) => pr.number);
  }
  // Scheduled: everything touched in the last two hours.
  const since = Date.now() - 2 * 60 * 60 * 1000;
  return open
    .filter((pr) => Date.parse(pr.updated_at) >= since)
    .map((pr) => pr.number);
}

// Every rule that skips a pull request must be settled from reads alone: a
// write bumps updated_at and would keep the pull request in the hourly sweep.
async function requestCopilotReview({
  github,
  core,
  context,
  prNumber,
  baseBranch = "",
  everyPush = false,
}) {
  const { owner, repo } = context.repo;
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  // Drafts and bot PRs (Dependabot) are not reviewed.
  if (
    pull.state !== "open" ||
    pull.draft ||
    pull.user?.type === "Bot" ||
    (baseBranch && pull.base.ref !== baseBranch)
  ) {
    core.info(`#${prNumber} is not eligible for a Copilot review; skipping.`);
    return;
  }
  const readTimeline = () =>
    github.paginate(github.rest.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
  let before = null;
  try {
    before = await readTimeline();
  } catch (err) {
    core.warning(
      `Could not read the timeline of #${prNumber}, so the request goes unconfirmed: ${err.message}`
    );
  }
  if (before) {
    const skip = skipReason(before, pull.head.sha, everyPush);
    if (skip) {
      core.info(`#${prNumber}: ${skip}; skipping.`);
      return;
    }
  }
  const { login: requester, stop } = await identify({ github, core });
  if (stop) return;
  try {
    await github.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: prNumber,
      reviewers: [COPILOT_REVIEWER],
    });
  } catch (err) {
    core.warning(`Could not request a Copilot review on #${prNumber}: ${err.message}`);
    return;
  }
  if (!before || !requester) return;
  let events;
  try {
    events = await readTimeline();
  } catch (err) {
    core.warning(
      `Requested a Copilot review on #${prNumber} but could not confirm it: ${err.message}`
    );
    return;
  }
  const seen = new Set(before.map((event) => event.id));
  const copilotRequests = events.filter(
    (event) =>
      event.event === "review_requested" &&
      COPILOT_LOGINS.has(event.requested_reviewer?.login)
  );
  // Ours is a request this token's account filed that was not there before.
  if (
    copilotRequests.some(
      (event) => event.actor?.login === requester && !seen.has(event.id)
    )
  ) {
    core.info(`Requested a Copilot review on #${prNumber}.`);
    return;
  }
  const last = pendingRequest(events);
  if (last) {
    core.info(
      `A Copilot review requested by ${last.actor?.login} is still pending on #${prNumber}.`
    );
    return;
  }
  core.warning(
    `GitHub accepted the Copilot review request on #${prNumber} but recorded none; ` +
      `${requester} likely has no Copilot seat.`
  );
}

// The account the token belongs to: { login }, {} when it can't be told
// (the request goes ahead unconfirmed), or { stop: true } when the token is rejected.
async function identify({ github, core }) {
  try {
    const { data } = await github.rest.users.getAuthenticated();
    return { login: data.login };
  } catch (err) {
    // An expired or revoked token fails loudly so someone rotates it.
    if (err.status === 401) {
      core.setFailed(
        `COPILOT_REVIEW_TOKEN was rejected (${err.message}); rotate esphome-review-bot's token.`
      );
      return { stop: true };
    }
    core.warning(
      `Could not identify the requesting account, so the request goes unconfirmed: ${err.message}`
    );
    return {};
  }
}

function reviewedSince(events, since) {
  return events.some(
    (event) =>
      event.event === "reviewed" &&
      COPILOT_LOGINS.has(event.user?.login) &&
      Date.parse(event.submitted_at) >= Date.parse(since)
  );
}

// Why Copilot needs no new request, or "" when it does. Without every-push a
// request that was ever made is enough: that stands in for reviewing only when
// a pull request is opened, reopened or marked ready.
function skipReason(events, headSha, everyPush) {
  if (!everyPush) {
    return events.some(
      (event) =>
        event.event === "review_requested" &&
        COPILOT_LOGINS.has(event.requested_reviewer?.login)
    )
      ? "a Copilot review was already requested"
      : "";
  }
  if (pendingRequest(events)) return "a Copilot review is still pending";
  return events.some(
    (event) =>
      event.event === "reviewed" &&
      COPILOT_LOGINS.has(event.user?.login) &&
      event.commit_id === headSha
  )
    ? "Copilot already reviewed the current commit"
    : "";
}

// The latest Copilot request, when no Copilot review has followed it.
function pendingRequest(events) {
  const last = events
    .filter(
      (event) =>
        (event.event === "review_requested" ||
          event.event === "review_request_removed") &&
        COPILOT_LOGINS.has(event.requested_reviewer?.login)
    )
    .at(-1);
  return last?.event === "review_requested" && !reviewedSince(events, last.created_at)
    ? last
    : undefined;
}

module.exports = { findPullRequests, requestCopilotReview };
