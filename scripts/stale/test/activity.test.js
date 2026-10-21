'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {hasRealActivitySince, labelDate} = require('../activity');
const {createFake, ago, issue, node, comment, labeled, review} = require('./fake-github');
const {makeCtx} = require('./harness');

const since = new Date(ago(10));

function setup({item = issue(1, {pr: true}), prNode, ...state} = {}, env = {}) {
  const fake = createFake(state);
  const ctx = makeCtx(fake, env);
  if (prNode) ctx.prs.set(prNode.number, prNode);
  return {fake, ctx, item};
}

test('a new comment by a user is real activity', async () => {
  const {ctx, item, fake} = setup({item: issue(1), comments: {1: [comment('alice', 2)]}});
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
  const call = fake.named('paginate:rest.issues.listComments')[0];
  assert.equal(call.params.since, since.toISOString());
  assert.equal(call.params.per_page, 100);
});

test('edited old comments, bots, ignored users and missing users do not count', async () => {
  const {ctx, item} = setup({
    item: issue(1),
    comments: {1: [
      comment('alice', 50),
      comment('dependabot', 2, 'Bot'),
      comment('robot', 2),
      {created_at: ago(2)},
    ]},
  }, {STALE_IGNORED_USERS: 'robot'});
  assert.equal(await hasRealActivitySince(ctx, item, since), false);
});

test('issues never look at commits or reviews', async () => {
  const {ctx, item, fake} = setup({item: issue(1)});
  assert.equal(await hasRealActivitySince(ctx, item, since), false);
  assert.equal(fake.count('paginate:rest.pulls.listReviews'), 0);
  assert.equal(fake.count('rest.repos.getCommit'), 0);
});

test('a recent head commit from the prefetch is real activity', async () => {
  const {ctx, item, fake} = setup({
    prNode: node(1, {head: {oid: 'sha1', committedDate: ago(2)}}),
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
  assert.equal(fake.count('rest.pulls.get'), 0);
});

test('the prefetched authoredDate is used when committedDate is missing', async () => {
  const {ctx, item} = setup({
    prNode: node(1, {head: {oid: 'sha1', committedDate: null, authoredDate: ago(2)}}),
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
});

test('an old prefetched head commit falls through to reviews', async () => {
  const {ctx, item, fake} = setup({prNode: node(1)});
  assert.equal(await hasRealActivitySince(ctx, item, since), false);
  assert.equal(fake.count('rest.repos.getCommit'), 0);
  assert.equal(fake.count('paginate:rest.pulls.listReviews'), 1);
});

test('a prefetched commit that is not the current head uses the REST lookup', async () => {
  const {ctx, item, fake} = setup({
    prNode: node(1, {head: {oid: 'old', committedDate: ago(200)}}),
    pulls: {1: {head: {sha: 'sha1'}}},
    commits: {sha1: {commit: {committer: {date: ago(2)}, author: {date: ago(200)}}}},
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
  assert.equal(fake.named('rest.repos.getCommit')[0].params.ref, 'sha1');
});

test('a PR missing from the prefetch uses the REST lookup', async () => {
  const {ctx, item, fake} = setup({
    pulls: {1: {head: {sha: 'abc'}}},
    commits: {abc: {commit: {committer: null, author: {date: ago(2)}}}},
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
  assert.equal(fake.count('rest.pulls.get'), 1);
});

test('a prefetched node without commits uses the REST lookup', async () => {
  const {ctx, item} = setup({
    prNode: {...node(1), commits: {nodes: []}},
    pulls: {1: {head: {sha: 'abc'}}},
    commits: {abc: {commit: {committer: {date: ago(2)}}}},
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
});

test('an old REST head commit is not activity', async () => {
  const {ctx, item} = setup({
    pulls: {1: {head: {sha: 'abc'}}},
    commits: {abc: {commit: {committer: {date: ago(200)}}}},
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), false);
});

test('a REST commit without dates is not activity', async () => {
  const {ctx, item} = setup({
    pulls: {1: {head: {sha: 'abc'}}},
    commits: {abc: {commit: null}},
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), false);
});

test('a failed commit lookup is logged and reviews are still checked', async () => {
  const {ctx, item} = setup({
    pulls: {1: {head: {sha: 'abc'}}},
    reviews: {1: [{...review('alice', 'APPROVED'), submitted_at: ago(2)}]},
  });
  ctx.github.fail('rest.repos.getCommit', new Error('nope'));
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
  assert.deepEqual(ctx.log.text(), ['error: Commit check failed for #1: nope']);
});

test('a non-Error commit failure is logged as is', async () => {
  const {ctx, item} = setup({pulls: {1: {head: {sha: 'abc'}}}});
  ctx.github.fail('rest.repos.getCommit', 'plain');
  assert.equal(await hasRealActivitySince(ctx, item, since), false);
  assert.deepEqual(ctx.log.text(), ['error: Commit check failed for #1: plain']);
});

test('reviews count only when submitted by a real user since the cutoff', async () => {
  const stale = {prNode: node(1)};
  const cases = [
    [{...review('alice', 'COMMENTED'), submitted_at: ago(2)}, true],
    [{...review('alice', 'COMMENTED'), submitted_at: ago(50)}, false],
    [{...review('alice', 'PENDING'), submitted_at: null}, false],
    [{...review('robot', 'COMMENTED'), submitted_at: ago(2)}, false],
    [{user: null, submitted_at: ago(2)}, false],
  ];
  for (const [r, expected] of cases) {
    const {ctx, item} = setup({...stale, reviews: {1: [r]}}, {STALE_IGNORED_USERS: 'robot'});
    assert.equal(await hasRealActivitySince(ctx, item, since), expected);
  }
});

test('labelDate returns the most recent matching labeling event', async () => {
  const {ctx, item} = setup({
    item: issue(1),
    events: {1: [
      labeled('stale', 40),
      labeled('other', 5),
      {event: 'unlabeled', label: {name: 'stale'}, created_at: ago(30)},
      {event: 'labeled', created_at: ago(20)},
      labeled('stale', 10),
    ]},
  });
  assert.equal((await labelDate(ctx, item, 'stale')).toISOString(), ago(10));
});

test('labelDate is null when the label was never added', async () => {
  const {ctx, item} = setup({item: issue(1), events: {1: [labeled('other', 5)]}});
  assert.equal(await labelDate(ctx, item, 'stale'), null);
});

test('a prefetched node without a commits field uses the REST lookup', async () => {
  const prNode = node(1);
  delete prNode.commits;
  const {ctx, item} = setup({
    prNode,
    pulls: {1: {head: {sha: 'abc'}}},
    commits: {abc: {commit: {committer: {date: ago(2)}}}},
  });
  assert.equal(await hasRealActivitySince(ctx, item, since), true);
});
