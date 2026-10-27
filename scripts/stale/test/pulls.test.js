'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pulls = require('../pulls');
const {createFake, node} = require('./fake-github');
const {makeCtx} = require('./harness');

const CONFLICTS = {STALE_DAYS_BEFORE_STALE_CONFLICTING: '30'};

test('getPull fetches once per PR and caches', async () => {
  const fake = createFake({pulls: {3: {head: {sha: 'x'}}}});
  const ctx = makeCtx(fake);
  const first = await pulls.getPull(ctx, {number: 3});
  const second = await pulls.getPull(ctx, {number: 3});
  assert.equal(first, second);
  assert.equal(fake.count('rest.pulls.get'), 1);
});

test('getPull consumes a mergeable sequence over repeated REST reads', async () => {
  const fake = createFake({pulls: {3: {mergeable: [null, true]}, 4: {mergeable: [false]}}});
  const ctx = makeCtx(fake);
  assert.equal((await pulls.getPull(ctx, {number: 3})).mergeable, null);
  ctx.pulls.clear();
  assert.equal((await pulls.getPull(ctx, {number: 3})).mergeable, true);
  assert.equal((await pulls.getPull(ctx, {number: 4})).mergeable, false);
});

test('prefetch pages through every open PR and requests only needed fields', async () => {
  const fake = createFake({
    pageSize: 2,
    prs: [1, 2, 3, 4, 5].map(n => node(n, {mergeable: 'MERGEABLE'})),
  });
  const ctx = makeCtx(fake);
  await pulls.prefetchPulls(ctx);
  assert.deepEqual([...ctx.prs.keys()], [1, 2, 3, 4, 5]);
  assert.equal(fake.count('graphql:prefetch'), 3);
  const vars = fake.named('graphql:prefetch').map(c => c.params.vars);
  assert.deepEqual(vars.map(v => v.cursor), [null, '2', '4']);
  assert.equal(vars[0].withMergeable, false);
  assert.equal(vars[0].withCommits, true);
  assert.equal('mergeable' in ctx.prs.get(1), false);
  assert.equal(ctx.prefetchFailed, false);
});

test('prefetch asks for mergeable but not commits when conflicts-only', async () => {
  const fake = createFake({prs: [node(1, {mergeable: 'MERGEABLE'})]});
  const ctx = makeCtx(fake, {...CONFLICTS, STALE_CONFLICTS_ONLY: 'true'});
  await pulls.prefetchPulls(ctx);
  const {vars} = fake.named('graphql:prefetch')[0].params;
  assert.equal(vars.withMergeable, true);
  assert.equal(vars.withCommits, false);
  assert.equal(ctx.prs.get(1).mergeable, 'MERGEABLE');
  assert.equal('commits' in ctx.prs.get(1), false);
});

test('a failing page is retried and then succeeds', async () => {
  const fake = createFake({prs: [node(1)]});
  const slept = [];
  const ctx = makeCtx(fake);
  ctx.sleep = async ms => { slept.push(ms); };
  fake.fail('graphql:prefetch', new Error('502 Bad Gateway\nmore detail'), {times: 2});
  await pulls.prefetchPulls(ctx);
  assert.equal(ctx.prs.size, 1);
  assert.equal(ctx.prefetchFailed, false);
  assert.deepEqual(slept, [5000, 5000]);
  assert.deepEqual(ctx.log.text(), [
    'log: GraphQL page failed (attempt 1), retrying: 502 Bad Gateway',
    'log: GraphQL page failed (attempt 2), retrying: 502 Bad Gateway',
  ]);
});

test('a page that keeps failing gives up and clears the prefetch', async () => {
  const fake = createFake({pageSize: 1, prs: [node(1), node(2)]});
  const ctx = makeCtx(fake);
  fake.fail('graphql:prefetch', new Error('timeout'), {match: p => p.vars.cursor === '1'});
  await pulls.prefetchPulls(ctx);
  assert.equal(ctx.prs.size, 0);
  assert.equal(ctx.prefetchFailed, true);
  assert.equal(fake.count('graphql:prefetch'), 4);
  assert.equal(ctx.log.text().at(-1), 'error: GraphQL prefetch failed: timeout');
});

test('non-Error prefetch failures are logged as is', async () => {
  const fake = createFake();
  const ctx = makeCtx(fake);
  fake.fail('graphql:prefetch', 'plain');
  await pulls.prefetchPulls(ctx);
  assert.deepEqual(ctx.log.text(), [
    'log: GraphQL page failed (attempt 1), retrying: plain',
    'log: GraphQL page failed (attempt 2), retrying: plain',
    'error: GraphQL prefetch failed: plain',
  ]);
});

test('hasMergeConflicts reads GraphQL mergeable', async () => {
  const ctx = makeCtx(createFake());
  ctx.prs.set(1, node(1, {mergeable: 'CONFLICTING'}));
  ctx.prs.set(2, node(2, {mergeable: 'MERGEABLE'}));
  ctx.prs.set(3, node(3, {mergeable: 'UNKNOWN'}));
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 1}), true);
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 2}), false);
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 3}), null);
  assert.equal(ctx.github.count('rest.pulls.get'), 0);
});

test('hasMergeConflicts falls back to REST when the node has no mergeable', async () => {
  const fake = createFake({pulls: {
    1: {mergeable: false, mergeable_state: 'dirty'},
    2: {mergeable: false, mergeable_state: 'blocked'},
    3: {mergeable: true, mergeable_state: 'clean'},
    4: {mergeable: null},
  }});
  const ctx = makeCtx(fake);
  ctx.prs.set(1, node(1));
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 1}), true);
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 2}), false);
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 3}), false);
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 4}), null);
});

test('hasMergeConflicts logs REST failures and returns null', async () => {
  const ctx = makeCtx(createFake());
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 9}), null);
  ctx.github.fail('rest.pulls.get', 'plain');
  assert.equal(await pulls.hasMergeConflicts(ctx, {number: 9}), null);
  assert.deepEqual(ctx.log.text(), [
    'error: Conflict check failed for #9: pulls.get: no pull #9',
    'error: Conflict check failed for #9: plain',
  ]);
});

test('refreshMergeability updates nodes and reports the undecided ones', async () => {
  const fake = createFake({prs: [
    node(1, {mergeable: 'MERGEABLE'}),
    node(2, {mergeable: 'UNKNOWN'}),
  ]});
  const ctx = makeCtx(fake);
  ctx.prs.set(1, node(1, {mergeable: 'UNKNOWN'}));
  ctx.prs.set(2, node(2, {mergeable: 'UNKNOWN'}));
  ctx.prs.set(3, node(3, {mergeable: 'UNKNOWN'}));
  const still = await pulls.refreshMergeability(ctx, [1, 2, 3]);
  assert.deepEqual(still, [2]);
  assert.equal(ctx.prs.get(1).mergeable, 'MERGEABLE');
  assert.equal(ctx.prs.get(3).mergeable, 'UNKNOWN');
});

test('waitForMergeability waits for undecided PRs and skips locked and exempt ones', async () => {
  const fake = createFake({prs: [
    node(1, {mergeable: ['UNKNOWN', 'CONFLICTING']}),
    node(2, {mergeable: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'MERGEABLE']}),
    node(3, {mergeable: 'UNKNOWN', locked: true}),
    node(4, {mergeable: 'UNKNOWN', labels: ['not-stale']}),
    node(5, {mergeable: 'MERGEABLE'}),
  ]});
  const ctx = makeCtx(fake, CONFLICTS);
  const slept = [];
  ctx.sleep = async ms => { slept.push(ms); };
  await pulls.prefetchPulls(ctx);
  await pulls.waitForMergeability(ctx);
  assert.deepEqual(slept, [10000, 10000, 10000]);
  assert.equal(ctx.prs.get(1).mergeable, 'CONFLICTING');
  assert.equal(ctx.prs.get(2).mergeable, 'UNKNOWN');
  assert.equal(fake.count('graphql:refresh'), 3);
  assert.deepEqual(ctx.log.text(), [
    'log: Waiting for GitHub to compute mergeability of 2 PRs',
    'log: Waiting for GitHub to compute mergeability of 1 PRs',
    'log: Waiting for GitHub to compute mergeability of 1 PRs',
  ]);
});

test('waitForMergeability does nothing when nothing is undecided', async () => {
  const ctx = makeCtx(createFake(), CONFLICTS);
  ctx.prs.set(1, node(1, {mergeable: 'MERGEABLE'}));
  await pulls.waitForMergeability(ctx);
  assert.equal(ctx.github.count('graphql:refresh'), 0);
  assert.deepEqual(ctx.log.text(), []);
});

test('waitForMergeability refreshes in chunks and keeps a failed chunk pending', async () => {
  const total = 150;
  const nodes = Array.from({length: total}, (_, i) => node(i + 1, {mergeable: ['UNKNOWN', 'MERGEABLE']}));
  const fake = createFake({prs: nodes});
  const ctx = makeCtx(fake, CONFLICTS);
  await pulls.prefetchPulls(ctx);
  // Fail the first chunk once: its PRs stay pending and succeed next round
  fake.fail('graphql:refresh', new Error('chunk down'), {times: 1});
  await pulls.waitForMergeability(ctx);
  const sizes = fake.named('graphql:refresh').map(c => c.params.query.match(/pullRequest\(/g).length);
  assert.deepEqual(sizes, [100, 50, 100]);
  assert.equal([...ctx.prs.values()].filter(n => n.mergeable === 'UNKNOWN').length, 0);
  assert.ok(ctx.log.text().includes('error: Mergeability lookup failed for 100 PRs: chunk down'));
});

test('waitForMergeability logs non-Error chunk failures as is', async () => {
  const fake = createFake({prs: [node(1, {mergeable: 'UNKNOWN'})]});
  const ctx = makeCtx(fake, CONFLICTS);
  await pulls.prefetchPulls(ctx);
  fake.fail('graphql:refresh', 'plain', {times: 1});
  await pulls.waitForMergeability(ctx);
  assert.ok(ctx.log.text().includes('error: Mergeability lookup failed for 1 PRs: plain'));
});
