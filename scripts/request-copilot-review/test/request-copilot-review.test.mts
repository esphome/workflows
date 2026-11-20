import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The vitest matchers this test uses, on node:test.
const expect = (actual: any) => ({
  toBe: (expected: unknown) => assert.equal(actual, expected),
  toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
  toMatch: (re: RegExp) => assert.match(actual, re),
  toHaveLength: (n: number) => assert.equal(actual.length, n),
});

type Core = {
  info: (m: string) => void;
  warning: (m: string) => void;
  setFailed: (m: string) => void;
};
type Module = {
  findPullRequests: (args: Record<string, unknown>) => Promise<number[]>;
  requestCopilotReview: (args: Record<string, unknown>) => Promise<void>;
};

const { findPullRequests, requestCopilotReview } = (
  (await import("../request-copilot-review.cjs")) as { default: Module }
).default;

const REPO = { owner: "esphome", repo: "device-builder-frontend" };

const OLD = "2020-01-01T00:00:00Z";
const LATER = "2020-01-01T00:05:00Z";
// The account the workflow's token belongs to.
const REQUESTER = "esphome-review-bot";
// "ours" is a request filed by REQUESTER; anything else stands for the ruleset
// or a maintainer.
const copilotRequest = (id: number, by: "ours" | "other", createdAt = LATER) => ({
  id,
  event: "review_requested",
  actor: { login: by === "ours" ? REQUESTER : "someone", type: "User" },
  requested_reviewer: { login: "Copilot" },
  created_at: createdAt,
});
const copilotReview = (id: number, submittedAt: string) => ({
  id,
  event: "reviewed",
  user: { login: "Copilot" },
  submitted_at: submittedAt,
});

const HEAD_SHA = "abc123";
const reviewedAt = (id: number, commitId: string, login = "Copilot") => ({
  ...copilotReview(id, LATER),
  user: { login },
  commit_id: commitId,
});

// before and after are the timeline reads around the request; timelineError
// makes that read throw. pull overrides fields of the pull request.
function makeGithub(
  opts: {
    fail?: boolean;
    before?: unknown[];
    after?: unknown[];
    timelineError?: "before" | "after";
    whoamiStatus?: number;
    pull?: Record<string, unknown>;
  } = {}
) {
  const calls: Record<string, unknown>[] = [];
  const reads = [
    { name: "before", events: opts.before ?? [] },
    { name: "after", events: opts.after ?? [copilotRequest(1, "ours")] },
  ];
  const listEventsForTimeline = () => {};
  const pull = {
    number: 9,
    state: "open",
    draft: false,
    user: { type: "User" },
    base: { ref: "main" },
    head: { sha: HEAD_SHA },
    ...opts.pull,
  };
  return {
    calls,
    reads,
    github: {
      paginate: async (fn: unknown) => {
        expect(fn).toBe(listEventsForTimeline);
        const read = reads.shift();
        if (!read) throw new Error("the timeline is read at most twice");
        if (opts.timelineError === read.name) {
          throw new Error("secondary rate limit");
        }
        return read.events;
      },
      rest: {
        users: {
          getAuthenticated: async () => {
            if (opts.whoamiStatus) {
              throw Object.assign(new Error("Bad credentials"), {
                status: opts.whoamiStatus,
              });
            }
            return { data: { login: REQUESTER } };
          },
        },
        issues: { listEventsForTimeline },
        pulls: {
          get: async (args: Record<string, unknown>) => {
            expect(args).toEqual({ ...REPO, pull_number: 9 });
            return { data: pull };
          },
          requestReviewers: async (args: Record<string, unknown>) => {
            if (opts.fail) {
              throw new Error("Reviews may only be requested from collaborators");
            }
            calls.push(args);
          },
        },
      },
    },
  };
}

function makeCore() {
  const warnings: string[] = [];
  const infos: string[] = [];
  const failures: string[] = [];
  const core: Core = {
    info: (m) => void infos.push(m),
    warning: (m) => void warnings.push(m),
    setFailed: (m) => void failures.push(m),
  };
  return { core, warnings, infos, failures };
}

const context = { repo: REPO };
const run = (github: unknown, core: Core, extra: Record<string, unknown> = {}) =>
  requestCopilotReview({ github, core, context, prNumber: 9, ...extra });

describe("request-copilot-review", () => {
  it("requests a Copilot review", async () => {
    const { github, calls } = makeGithub();
    const { core, infos, warnings } = makeCore();
    await run(github, core);
    expect(calls).toEqual([
      {
        ...REPO,
        pull_number: 9,
        reviewers: ["copilot-pull-request-reviewer[bot]"],
      },
    ]);
    expect(warnings).toEqual([]);
    expect(infos[0]).toMatch(/Requested a Copilot review on #9/);
  });

  it("requests a review on the configured base branch", async () => {
    const { github, calls } = makeGithub();
    const { core } = makeCore();
    await run(github, core, { baseBranch: "main" });
    expect(calls).toHaveLength(1);
  });

  for (const [name, pull, extra] of [
    ["closed", { state: "closed" }, {}],
    ["draft", { draft: true }, {}],
    ["bot", { user: { type: "Bot" } }, {}],
    ["other base branch", { base: { ref: "dev" } }, { baseBranch: "main" }],
  ] as const) {
    it(`skips a ${name} PR without reading anything else`, async () => {
      const { github, calls, reads } = makeGithub({ pull });
      const { core, infos } = makeCore();
      await run(github, core, extra);
      expect(calls).toEqual([]);
      expect(reads).toHaveLength(2);
      expect(infos[0]).toMatch(/#9 is not eligible/);
    });
  }

  for (const [name, everyPush, before, reason] of [
    ["any earlier request", false, [copilotRequest(1, "other", OLD)], /already requested/],
    [
      "a withdrawn earlier request",
      false,
      [
        copilotRequest(1, "other", OLD),
        { id: 2, event: "review_request_removed", requested_reviewer: { login: "Copilot" }, created_at: LATER },
      ],
      /already requested/,
    ],
    ["a pending request", true, [copilotRequest(1, "other")], /still pending/],
    ["a review of the head commit", true, [reviewedAt(1, HEAD_SHA)], /reviewed the current commit/],
    [
      "a review of the head commit by the bot account",
      true,
      [reviewedAt(1, HEAD_SHA, "copilot-pull-request-reviewer[bot]")],
      /reviewed the current commit/,
    ],
  ] as const) {
    it(`skips on ${name}`, async () => {
      const { github, calls, reads } = makeGithub({ before: [...before] });
      const { core, infos, warnings } = makeCore();
      await run(github, core, { everyPush });
      expect(calls).toEqual([]);
      expect(reads).toHaveLength(1);
      expect(warnings).toEqual([]);
      expect(infos[0]).toMatch(reason);
    });
  }

  for (const [name, before] of [
    ["a review of an older commit", [copilotRequest(1, "other", OLD), reviewedAt(2, "older")]],
    ["a review of another account", [reviewedAt(1, HEAD_SHA, "someone")]],
    ["a non-Copilot request", [{ id: 1, event: "review_requested", requested_reviewer: { login: "someone" }, created_at: OLD }]],
  ] as const) {
    it(`requests again with every-push despite ${name}`, async () => {
      const { github, calls } = makeGithub({ before: [...before] });
      const { core } = makeCore();
      await run(github, core, { everyPush: true });
      expect(calls).toHaveLength(1);
    });
  }

  for (const [name, before, requests] of [
    ["reopened", [copilotRequest(1, "other", OLD), { id: 2, event: "reopened" }], true],
    ["marked ready", [copilotRequest(1, "other", OLD), { id: 2, event: "ready_for_review" }], true],
    [
      "converted to draft and marked ready",
      [copilotRequest(1, "other", OLD), { id: 2, event: "convert_to_draft" }, { id: 3, event: "ready_for_review" }],
      true,
    ],
    ["reopened and then requested", [{ id: 1, event: "reopened" }, copilotRequest(2, "other")], false],
    [
      "pushed to only",
      [copilotRequest(1, "other", OLD), { id: 2, event: "committed" }, { id: 3, event: "head_ref_force_pushed" }],
      false,
    ],
    [
      "reopened with only a non-Copilot request",
      [{ id: 1, event: "reopened" }, { id: 2, event: "review_requested", requested_reviewer: { login: "someone" } }],
      true,
    ],
  ] as const) {
    it(`${requests ? "requests again" : "skips"} without every-push once ${name}`, async () => {
      const { github, calls, reads } = makeGithub({
        before: [...before],
        after: [...before, copilotRequest(99, "ours")],
      });
      const { core, infos, warnings } = makeCore();
      await run(github, core);
      expect(calls).toHaveLength(requests ? 1 : 0);
      expect(reads).toHaveLength(requests ? 0 : 1);
      expect(warnings).toEqual([]);
      if (!requests) expect(infos[0]).toMatch(/already requested/);
    });
  }

  it("ignores other earlier events without every-push", async () => {
    const { github, calls } = makeGithub({ before: [{ id: 1, event: "labeled" }] });
    const { core } = makeCore();
    await run(github, core);
    expect(calls).toHaveLength(1);
  });

  it("warns instead of failing when the request fails", async () => {
    const { github } = makeGithub({ fail: true });
    const { core, warnings } = makeCore();
    await run(github, core);
    expect(warnings[0]).toMatch(/Could not request a Copilot review on #9/);
  });

  it("warns when GitHub accepted the request but recorded none", async () => {
    const { github } = makeGithub({ after: [{ id: 1, event: "labeled" }] });
    const { core, warnings } = makeCore();
    await run(github, core);
    expect(warnings[0]).toMatch(/recorded none/);
  });

  it("does not take a request filed by another account as ours", async () => {
    const after = [copilotRequest(1, "other"), copilotReview(2, LATER)];
    const { github } = makeGithub({ after });
    const { core, warnings } = makeCore();
    await run(github, core);
    expect(warnings[0]).toMatch(/recorded none/);
  });

  it("does not take an earlier request by the same account as this one", async () => {
    const earlier = [copilotRequest(1, "ours", OLD), copilotReview(2, LATER)];
    const { github } = makeGithub({ before: earlier, after: earlier });
    const { core, warnings } = makeCore();
    await run(github, core, { everyPush: true });
    expect(warnings[0]).toMatch(/recorded none/);
  });

  it("logs a request filed by someone else meanwhile instead of warning", async () => {
    const { github } = makeGithub({ after: [copilotRequest(2, "other")] });
    const { core, infos, warnings } = makeCore();
    await run(github, core);
    expect(warnings).toEqual([]);
    expect(infos[0]).toMatch(/requested by someone is still pending on #9/);
  });

  it("does not count a removed Copilot request as pending", async () => {
    const earlier = [
      copilotRequest(1, "other"),
      {
        id: 2,
        event: "review_request_removed",
        requested_reviewer: { login: "Copilot" },
        created_at: LATER,
      },
    ];
    const { github } = makeGithub({ before: earlier, after: earlier });
    const { core, warnings } = makeCore();
    await run(github, core, { everyPush: true });
    expect(warnings[0]).toMatch(/recorded none/);
  });

  it("ends a pending request on a review under the bot account login", async () => {
    const earlier = [
      copilotRequest(1, "other", OLD),
      {
        id: 2,
        event: "reviewed",
        user: { login: "copilot-pull-request-reviewer[bot]" },
        submitted_at: LATER,
      },
    ];
    const { github } = makeGithub({ before: earlier, after: earlier });
    const { core, warnings } = makeCore();
    await run(github, core, { everyPush: true });
    expect(warnings[0]).toMatch(/recorded none/);
  });

  it("warns when the timeline read after the request fails", async () => {
    const { github, calls } = makeGithub({ timelineError: "after" });
    const { core, warnings } = makeCore();
    await run(github, core);
    expect(calls).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not confirm it: secondary rate limit/);
  });

  it("still requests the review when the baseline read fails", async () => {
    const { github, calls } = makeGithub({ timelineError: "before" });
    const { core, warnings } = makeCore();
    await run(github, core);
    expect(calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/goes unconfirmed: secondary rate limit/);
  });

  it("fails the run when the token is rejected", async () => {
    const { github, calls } = makeGithub({ whoamiStatus: 401 });
    const { core, failures } = makeCore();
    await run(github, core);
    expect(calls).toHaveLength(0);
    expect(failures[0]).toMatch(/COPILOT_REVIEW_TOKEN was rejected/);
  });

  it("still requests unconfirmed when the account lookup fails", async () => {
    const { github, calls, reads } = makeGithub({ whoamiStatus: 502 });
    const { core, warnings, failures } = makeCore();
    await run(github, core);
    expect(calls).toHaveLength(1);
    expect(reads).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Could not identify the requesting account/);
  });
});

describe("findPullRequests", () => {
  const HOUR = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const pr = (number: number, sha: string, repoId: number | null, updated: string) => ({
    number,
    head: { sha, repo: repoId === null ? null : { id: repoId } },
    updated_at: updated,
  });
  const open = [
    pr(1, "sha1", 10, ago(HOUR / 2)),
    pr(2, "sha1", 20, ago(HOUR)),
    pr(3, "sha2", 10, ago(3 * HOUR)),
    pr(4, "sha1", null, ago(5 * HOUR)),
  ];
  const find = (eventName: string, extra: Record<string, unknown> = {}) => {
    const list = () => {};
    return findPullRequests({
      github: {
        rest: { pulls: { list } },
        paginate: async (fn: unknown, args: Record<string, unknown>) => {
          expect(fn).toBe(list);
          expect(args).toEqual({
            ...REPO,
            state: "open",
            sort: "updated",
            direction: "desc",
            per_page: 100,
          });
          return open;
        },
      },
      context: { eventName, repo: REPO, ...extra },
      prNumber: "7",
    });
  };

  it("uses the number given to workflow_dispatch", async () => {
    expect(await find("workflow_dispatch")).toEqual([7]);
  });

  it("matches a workflow_run on head commit and head repository", async () => {
    const payload = { workflow_run: { head_sha: "sha1", head_repository: { id: 10 } } };
    expect(await find("workflow_run", { payload })).toEqual([1]);
  });

  it("takes pull requests updated in the last two hours when scheduled", async () => {
    expect(await find("schedule")).toEqual([1, 2]);
  });
});
