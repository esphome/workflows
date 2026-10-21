'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createFake, ago, issue, node, comment, labeled, review} = require('./fake-github');
const {runStale} = require('./harness');

const CONFLICTS = {STALE_DAYS_BEFORE_STALE_CONFLICTING: '30'};
const names = fake => fake.writes().map(c => c.name);

// ---- skipped items ------------------------------------------------------

test('locked, exempt and fresh items are left alone', async () => {
  const fake = createFake({issues: [
    issue(1, {locked: true, updated: 200}),
    issue(2, {labels: ['not-stale'], updated: 200}),
    issue(3, {updated: 5, created: 10}),
    issue(4, {pr: true, updated: 5, created: 10}),
  ]});
  const {counters} = await runStale(fake);
  assert.deepEqual(counters, {marked: 0, unmarked: 0, closed: 0, conflicts: 0, resolved: 0, unknown: 0});
  assert.equal(fake.calls.filter(c => c.name !== 'rest.issues.listForRepo' && c.name !== 'graphql:prefetch' &&
    c.name !== 'paginate:rest.issues.listForRepo').length, 0);
});

// ---- marking stale ------------------------------------------------------

test('an inactive issue gets the issue message and the stale label', async () => {
  const fake = createFake({issues: [issue(1, {updated: 100})]});
  const {counters, log} = await runStale(fake);
  assert.equal(counters.marked, 1);
  assert.deepEqual(names(fake), ['rest.issues.createComment', 'rest.issues.addLabels']);
  assert.equal(fake.writes()[0].params.body, 'issue stale');
  assert.deepEqual(fake.writes()[1].params.labels, ['stale']);
  assert.match(log.text()[3],
    new RegExp(`^log: Marking issue #1 as stale: no real activity since ${ago(90)} \\(updated_at ${ago(100)}\\)$`));
  assert.equal(fake.count('paginate:rest.issues.listComments'), 0);
});

test('an inactive PR gets the PR message', async () => {
  const fake = createFake({issues: [issue(2, {pr: true, updated: 100})]});
  const {log} = await runStale(fake);
  assert.equal(fake.writes()[0].params.body, 'pr stale');
  assert.match(log.text()[3], /^log: Marking PR #2 as stale/);
});

test('dry run logs but never writes', async () => {
  const fake = createFake({
    issues: [
      issue(1, {updated: 100}),
      issue(2, {labels: ['stale'], updated: 1}),
      issue(3, {labels: ['stale']}),
    ],
    events: {2: [labeled('stale', 20)], 3: [labeled('stale', 20)]},
    comments: {2: [comment('alice', 1)]},
  });
  const {counters, log} = await runStale(fake, {STALE_DRY_RUN: 'true'});
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(counters, {marked: 1, unmarked: 1, closed: 1, conflicts: 0, resolved: 0, unknown: 0});
  assert.equal(log.text().at(-1),
    'log: Done (dry run): 1 marked, 1 unmarked, 1 closed, 0 labelled for merge conflicts, ' +
    '0 conflicts resolved, 0 with mergeability not known yet');
});

test('the done line has no dry-run marker on a real run', async () => {
  const {log} = await runStale(createFake());
  assert.equal(log.text().at(-1),
    'log: Done: 0 marked, 0 unmarked, 0 closed, 0 labelled for merge conflicts, ' +
    '0 conflicts resolved, 0 with mergeability not known yet');
});

test('start lines and item count are logged', async () => {
  const {log} = await runStale(createFake({issues: [issue(1)]}), CONFLICTS);
  assert.deepEqual(log.text().slice(0, 5), [
    `log: Will mark items without real activity since: ${ago(90)}`,
    `log: Will mark PRs labelled for merge conflicts before: ${ago(30)}`,
    `log: Will close items marked stale before: ${ago(7)}`,
    'log: Processing 1 open items',
    log.text()[4],
  ]);
  const plain = await runStale(createFake());
  assert.equal(plain.log.text().length, 4);
  assert.equal(plain.log.text()[2], 'log: Processing 0 open items');
});

// ---- phantom updated_at verification -----------------------------------

test('a fresh updated_at on an old item is verified against real comments', async () => {
  const base = {updated: 1, created: 200};
  const cases = [
    ['a new user comment keeps it open', [comment('alice', 2)], 0],
    ['an edited old comment does not', [comment('alice', 100)], 1],
    ['a bot comment does not', [comment('github-actions', 2, 'Bot')], 1],
    ['an ignored user does not', [comment('robot', 2)], 1],
  ];
  for (const [label, comments, marked] of cases) {
    const fake = createFake({issues: [issue(1, base)], comments: {1: comments}});
    const {counters} = await runStale(fake, {STALE_IGNORED_USERS: 'robot'});
    assert.equal(counters.marked, marked, label);
  }
});

test('a PR with a recent head commit from the prefetch is active', async () => {
  const fake = createFake({
    issues: [issue(1, {pr: true, updated: 1})],
    prs: [node(1, {head: {oid: 'sha1', committedDate: ago(2)}})],
  });
  const {counters} = await runStale(fake);
  assert.equal(counters.marked, 0);
  assert.equal(fake.count('rest.pulls.get'), 0);
});

test('a PR whose prefetched head differs uses the REST commit date', async () => {
  const base = {pulls: {1: {head: {sha: 'new'}}}, issues: [issue(1, {pr: true, updated: 1})]};
  const recent = createFake({
    ...base,
    prs: [node(1, {head: {oid: 'old', committedDate: ago(200)}})],
    commits: {new: {commit: {committer: {date: ago(2)}}}},
  });
  assert.equal((await runStale(recent)).counters.marked, 0);
  assert.equal(recent.count('rest.repos.getCommit'), 1);

  const missing = createFake({
    ...base,
    commits: {new: {commit: {committer: {date: ago(2)}}}},
  });
  assert.equal((await runStale(missing)).counters.marked, 0);
});

test('a recent review keeps a PR open', async () => {
  const fake = createFake({
    issues: [issue(1, {pr: true, updated: 1})],
    prs: [node(1)],
    reviews: {1: [{...review('alice', 'COMMENTED'), submitted_at: ago(2)}]},
  });
  assert.equal((await runStale(fake)).counters.marked, 0);
});

test('a PR whose commit lookup fails is still checked for reviews, then marked', async () => {
  const fake = createFake({issues: [issue(1, {pr: true, updated: 1})]});
  const {counters, log} = await runStale(fake);
  assert.equal(counters.marked, 1);
  assert.ok(log.text().includes('error: Commit check failed for #1: pulls.get: no pull #1'));
});

// ---- already stale ------------------------------------------------------

test('a stale issue with new activity is unmarked', async () => {
  const fake = createFake({
    issues: [issue(1, {labels: ['stale'], updated: 1})],
    events: {1: [labeled('stale', 20)]},
    comments: {1: [comment('alice', 1)]},
  });
  const {counters, log} = await runStale(fake);
  assert.equal(counters.unmarked, 1);
  assert.deepEqual(fake.writes(), [{
    name: 'rest.issues.removeLabel',
    params: {owner: 'o', repo: 'r', issue_number: 1, name: 'stale'},
  }]);
  assert.ok(log.text().includes('log: Unmarking issue #1: real activity since it was marked stale'));
  // Measured from the labeling, which is later than the stale cutoff
  assert.equal(fake.named('paginate:rest.issues.listComments')[0].params.since, ago(20));
});

test('activity is measured from the stale cutoff for an old stale label', async () => {
  const fake = createFake({
    issues: [issue(1, {labels: ['stale'], updated: 1})],
    events: {1: [labeled('stale', 200)]},
  });
  await runStale(fake);
  assert.equal(fake.named('paginate:rest.issues.listComments')[0].params.since, ago(90));
});

test('a stale PR with new activity is unmarked', async () => {
  const fake = createFake({
    issues: [issue(1, {labels: ['stale'], pr: true, updated: 1})],
    events: {1: [labeled('stale', 20)]},
    comments: {1: [comment('alice', 1)]},
  });
  const {log} = await runStale(fake);
  assert.ok(log.text().includes('log: Unmarking PR #1: real activity since it was marked stale'));
});

test('a stale issue past the close window is closed as not planned', async () => {
  const fake = createFake({
    issues: [issue(1, {labels: ['stale'], updated: 20})],
    events: {1: [labeled('stale', 10)]},
  });
  const {counters, log} = await runStale(fake);
  assert.equal(counters.closed, 1);
  assert.deepEqual(fake.writes()[0].params, {
    owner: 'o', repo: 'r', issue_number: 1, state: 'closed', state_reason: 'not_planned',
  });
  assert.ok(log.text().includes(`log: Closing issue #1: no real activity since stale on ${ago(10)}`));
});

test('a stale PR past the close window is closed without a reason', async () => {
  const fake = createFake({
    issues: [issue(1, {labels: ['stale'], pr: true, updated: 20})],
    events: {1: [labeled('stale', 10)]},
  });
  await runStale(fake);
  assert.deepEqual(fake.writes()[0].params, {
    owner: 'o', repo: 'r', issue_number: 1, state: 'closed',
  });
});

test('a recently stale item without activity is left for now', async () => {
  const fake = createFake({
    issues: [issue(1, {labels: ['stale'], updated: 20})],
    events: {1: [labeled('stale', 3)]},
  });
  const {counters} = await runStale(fake);
  assert.equal(fake.writes().length, 0);
  assert.equal(counters.closed + counters.unmarked, 0);
});

test('a stale item without a labeling event is skipped with a warning', async () => {
  const fake = createFake({issues: [issue(1, {labels: ['stale'], updated: 20})]});
  const {log} = await runStale(fake);
  assert.equal(fake.writes().length, 0);
  assert.ok(log.text().includes('warn: No stale labeling event found for #1; skipping'));
});

// ---- merge conflicts ----------------------------------------------------

function conflictPr(number, {mergeable, labels = [], updated = 1, created = 200, user = 'alice', ...rest} = {}) {
  return {
    item: issue(number, {pr: true, labels, updated, created, user}),
    node: node(number, {mergeable, labels, updated, created, ...rest}),
  };
}

function conflictFake(prList, state = {}) {
  return createFake({
    issues: prList.map(p => p.item),
    prs: prList.map(p => p.node),
    ...state,
  });
}

test('a new conflict gets a review and the label', async () => {
  const fake = conflictFake([conflictPr(1, {mergeable: 'CONFLICTING'})]);
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.conflicts, 1);
  assert.deepEqual(names(fake), ['rest.pulls.createReview', 'rest.issues.addLabels']);
  assert.deepEqual(fake.writes()[1].params.labels, ['needs-rebase']);
  assert.ok(log.text().includes('log: Labelling PR #1 for merge conflicts'));
});

test('the bot\'s own conflicting PR gets a comment instead of a review', async () => {
  const fake = conflictFake([conflictPr(1, {mergeable: 'CONFLICTING', user: 'esphome[bot]'})]);
  await runStale(fake, CONFLICTS);
  assert.deepEqual(names(fake), ['rest.issues.createComment', 'rest.issues.addLabels']);
  assert.equal(fake.writes()[0].params.body, 'pr conflict');
});

test('dry run does not label new conflicts', async () => {
  const fake = conflictFake([conflictPr(1, {mergeable: 'CONFLICTING'})]);
  const {counters} = await runStale(fake, {...CONFLICTS, STALE_DRY_RUN: 'true'});
  assert.equal(counters.conflicts, 1);
  assert.equal(fake.writes().length, 0);
});

test('issues are not checked for conflicts', async () => {
  const fake = conflictFake([], {issues: [issue(1, {updated: 5, created: 10})]});
  await runStale(fake, CONFLICTS);
  assert.equal(fake.count('rest.pulls.get'), 0);
});

test('a mergeable PR with the conflict label has it removed with the bot reviews dismissed', async () => {
  const fake = conflictFake([conflictPr(1, {mergeable: 'MERGEABLE', labels: ['needs-rebase'], updated: 5, created: 10})], {
    reviews: {1: [
      {...review('esphome[bot]', 'CHANGES_REQUESTED'), id: 10},
      {...review('alice', 'CHANGES_REQUESTED'), id: 11},
    ]},
  });
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.resolved, 1);
  assert.deepEqual(fake.writes().map(c => [c.name, c.params.review_id ?? c.params.name]), [
    ['rest.pulls.dismissReview', 10],
    ['rest.issues.removeLabel', 'needs-rebase'],
  ]);
  assert.ok(log.text().includes('log: PR #1 is mergeable again; removing needs-rebase'));
});

test('dry run does not remove the conflict label', async () => {
  const fake = conflictFake([conflictPr(1, {mergeable: 'MERGEABLE', labels: ['needs-rebase'], updated: 5, created: 10})]);
  const {counters} = await runStale(fake, {...CONFLICTS, STALE_DRY_RUN: 'true'});
  assert.equal(counters.resolved, 1);
  assert.equal(fake.writes().length, 0);
});

test('an unknown mergeability is counted and the PR falls through', async () => {
  const fake = conflictFake([conflictPr(1, {mergeable: 'UNKNOWN', updated: 100})]);
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.unknown, 1);
  assert.equal(counters.marked, 1);
  assert.ok(log.text().includes('log: PR #1: mergeability not known yet'));
  assert.equal(fake.writes()[0].params.body, 'pr stale');
});

test('a mergeable PR without the label and a still-fresh conflict fall through to inactivity', async () => {
  const fake = conflictFake([
    conflictPr(1, {mergeable: 'MERGEABLE', updated: 5, created: 10}),
    conflictPr(2, {mergeable: 'CONFLICTING', labels: ['needs-rebase'], updated: 5, created: 10}),
    conflictPr(3, {mergeable: 'CONFLICTING', labels: ['needs-rebase'], updated: 5, created: 10}),
  ], {events: {2: [labeled('needs-rebase', 5)]}});
  const {counters} = await runStale(fake, CONFLICTS);
  assert.deepEqual(counters, {marked: 0, unmarked: 0, closed: 0, conflicts: 0, resolved: 0, unknown: 0});
  assert.equal(fake.writes().length, 0);
});

test('a conflict unresolved for too long marks the PR stale with the conflict message', async () => {
  const fake = conflictFake([
    conflictPr(1, {mergeable: 'CONFLICTING', labels: ['needs-rebase'], updated: 1, created: 10}),
  ], {events: {1: [labeled('needs-rebase', 40)]}});
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.marked, 1);
  assert.deepEqual(names(fake), ['rest.issues.createComment', 'rest.issues.addLabels']);
  assert.equal(fake.writes()[0].params.body, 'pr stale conflicting');
  assert.deepEqual(fake.writes()[1].params.labels, ['stale']);
  assert.ok(log.text().includes(
    `log: Marking PR #1 as stale: merge conflicts unresolved since ${ago(40)}`));
});

test('dry run does not mark a long-conflicting PR stale', async () => {
  const fake = conflictFake([
    conflictPr(1, {mergeable: 'CONFLICTING', labels: ['needs-rebase']}),
  ], {events: {1: [labeled('needs-rebase', 40)]}});
  const {counters} = await runStale(fake, {...CONFLICTS, STALE_DRY_RUN: 'true'});
  assert.equal(counters.marked, 1);
  assert.equal(fake.writes().length, 0);
});

test('an inactive conflicting PR inside the window gets the conflict stale message', async () => {
  const fake = conflictFake([
    conflictPr(1, {mergeable: 'CONFLICTING', labels: ['needs-rebase'], updated: 100}),
  ], {events: {1: [labeled('needs-rebase', 5)]}});
  await runStale(fake, CONFLICTS);
  assert.equal(fake.writes()[0].params.body, 'pr stale conflicting');
});

test('an inactive PR without a conflict label gets the plain PR message with conflicts enabled', async () => {
  const fake = conflictFake([conflictPr(1, {mergeable: 'MERGEABLE', updated: 100})]);
  await runStale(fake, CONFLICTS);
  assert.equal(fake.writes()[0].params.body, 'pr stale');
});

test('a conflict label with no labeling event falls through to inactivity', async () => {
  const fake = conflictFake([
    conflictPr(1, {mergeable: 'CONFLICTING', labels: ['needs-rebase'], updated: 5, created: 10}),
  ]);
  const {counters} = await runStale(fake, CONFLICTS);
  assert.equal(counters.marked, 0);
});

// ---- stale and conflicting ---------------------------------------------

const stalePr = (number, mergeable, extra = {}) =>
  conflictPr(number, {mergeable, labels: ['stale', 'needs-rebase'], ...extra});

test('a stale PR whose conflicts are resolved loses both labels', async () => {
  const fake = conflictFake([stalePr(1, 'MERGEABLE')], {
    events: {1: [labeled('stale', 20)]},
    reviews: {1: [{...review('esphome[bot]', 'CHANGES_REQUESTED'), id: 7}]},
  });
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.resolved, 1);
  assert.equal(counters.unmarked, 1);
  assert.deepEqual(fake.writes().map(c => c.params.name ?? c.params.review_id), [7, 'needs-rebase', 'stale']);
  assert.ok(log.text().includes('log: Unmarking PR #1: mergeable again'));
});

test('dry run keeps the labels of a resolved stale PR', async () => {
  const fake = conflictFake([stalePr(1, 'MERGEABLE')], {events: {1: [labeled('stale', 20)]}});
  const {counters} = await runStale(fake, {...CONFLICTS, STALE_DRY_RUN: 'true'});
  assert.equal(counters.unmarked, 1);
  assert.equal(fake.writes().length, 0);
});

test('a stale PR with unknown mergeability is skipped', async () => {
  const fake = conflictFake([stalePr(1, 'UNKNOWN')], {events: {1: [labeled('stale', 20)]}});
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.unknown, 1);
  assert.equal(fake.writes().length, 0);
  assert.ok(log.text().includes('log: Skipping PR #1: mergeability not known yet'));
});

test('a stale PR with unresolved conflicts is closed, not rescued by comments', async () => {
  const fake = conflictFake([stalePr(1, 'CONFLICTING')], {
    events: {1: [labeled('stale', 10)]},
    comments: {1: [comment('alice', 1)]},
  });
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.closed, 1);
  assert.equal(fake.count('paginate:rest.issues.listComments'), 0);
  assert.ok(log.text().includes(
    `log: Closing PR #1: merge conflicts unresolved since stale on ${ago(10)}`));
});

test('a stale PR with unresolved conflicts inside the close window is left', async () => {
  const fake = conflictFake([stalePr(1, 'CONFLICTING')], {events: {1: [labeled('stale', 3)]}});
  const {counters} = await runStale(fake, CONFLICTS);
  assert.equal(counters.closed, 0);
  assert.equal(fake.writes().length, 0);
});

// ---- conflicts-only -----------------------------------------------------

const ONLY = {...CONFLICTS, STALE_CONFLICTS_ONLY: 'true'};

test('conflicts-only handles just the conflict transitions from the prefetch', async () => {
  const fake = createFake({prs: [
    node(1, {mergeable: 'CONFLICTING'}),
    node(2, {mergeable: 'MERGEABLE', labels: ['needs-rebase']}),
    node(3, {mergeable: 'MERGEABLE', labels: ['stale', 'needs-rebase']}),
    node(4, {mergeable: 'CONFLICTING', labels: ['stale', 'needs-rebase']}),
    node(5, {mergeable: 'CONFLICTING', labels: ['stale']}),
    node(6, {mergeable: 'CONFLICTING', labels: ['needs-rebase'], updated: 100}),
    node(7, {mergeable: 'MERGEABLE', updated: 100}),
    node(8, {mergeable: 'MERGEABLE', labels: ['not-stale']}),
    node(9, {mergeable: 'MERGEABLE', locked: true}),
    node(10, {mergeable: 'CONFLICTING', author: {__typename: 'Bot', login: 'esphome'}}),
    node(11, {mergeable: 'CONFLICTING', author: null}),
  ]});
  const {counters, log} = await runStale(fake, ONLY);
  assert.deepEqual(counters, {marked: 0, unmarked: 1, closed: 0, conflicts: 3, resolved: 2, unknown: 0});
  for (const name of [
    'rest.issues.listForRepo', 'paginate:rest.issues.listForRepo', 'paginate:rest.issues.listEvents',
    'paginate:rest.issues.listComments', 'rest.pulls.get', 'rest.repos.getCommit',
  ]) {
    assert.equal(fake.count(name), 0, name);
  }
  assert.deepEqual(fake.named('graphql:prefetch')[0].params.vars.withCommits, false);
  assert.deepEqual(log.text().slice(0, 2), [
    'log: Conflicts only: labelling PRs with merge conflicts and unmarking stale ones that are mergeable again',
    'log: Processing 11 open PRs (conflicts only)',
  ]);
  // Newest number first, and the bot-authored PR (10) is commented on, others reviewed
  const labelled = log.text().filter(l => l.includes('Labelling')).map(l => l.match(/#(\d+)/)[1]);
  assert.deepEqual(labelled, ['11', '10', '1']);
  const bodies = fake.writes().filter(c => c.name === 'rest.issues.createComment').map(c => c.params.issue_number);
  assert.deepEqual(bodies, [10]);
  assert.equal(fake.count('rest.pulls.createReview'), 2);
  assert.equal(log.text().at(-1),
    'log: Done: 0 marked, 1 unmarked, 0 closed, 3 labelled for merge conflicts, ' +
    '2 conflicts resolved, 0 with mergeability not known yet');
});

test('conflicts-only waits for mergeability before deciding', async () => {
  const fake = createFake({prs: [node(1, {mergeable: ['UNKNOWN', 'CONFLICTING']})]});
  const {counters, sleeps} = await runStale(fake, ONLY);
  assert.deepEqual(sleeps, [10000]);
  assert.equal(counters.conflicts, 1);
});

test('conflicts-only needs days-before-stale-conflicting', async () => {
  const fake = createFake({prs: [node(1)]});
  const {counters, core, log} = await runStale(fake, {STALE_CONFLICTS_ONLY: 'true'});
  assert.equal(counters, null);
  assert.deepEqual(core.failures, ['conflicts-only needs days-before-stale-conflicting to be set']);
  assert.equal(fake.calls.length, 0);
  assert.equal(log.lines.length, 0);
});

test('conflicts-only fails when the prefetch fails', async () => {
  const fake = createFake({prs: [node(1)]});
  fake.fail('graphql:prefetch', new Error('down'));
  const {counters, core, sleeps} = await runStale(fake, ONLY);
  assert.equal(counters, null);
  assert.deepEqual(core.failures, ['conflicts-only needs the GraphQL prefetch, which failed']);
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.equal(fake.writes().length, 0);
});

// ---- resilience ---------------------------------------------------------

test('a failing item is logged and the run continues', async () => {
  const fake = createFake({issues: [issue(1, {updated: 100}), issue(2, {updated: 100})]});
  fake.fail('rest.issues.createComment', new Error('boom'), {match: p => p.issue_number === 1});
  const {counters, log} = await runStale(fake);
  assert.equal(counters.marked, 1);
  assert.ok(log.text().includes('error: Failed to process #1: boom'));
  assert.equal(fake.named('rest.issues.addLabels')[0].params.issue_number, 2);
});

test('a non-Error item failure is logged as is', async () => {
  const fake = createFake({issues: [issue(1, {updated: 100})]});
  fake.fail('rest.issues.createComment', 'plain');
  const {log} = await runStale(fake);
  assert.ok(log.text().includes('error: Failed to process #1: plain'));
});

test('a failed prefetch in a full run falls back to REST lookups', async () => {
  const fake = createFake({
    issues: [issue(1, {pr: true, labels: ['needs-rebase'], updated: 5, created: 10})],
    pulls: {1: {mergeable: true, mergeable_state: 'clean', head: {sha: 'x'}}},
    reviews: {1: [{...review('esphome[bot]', 'CHANGES_REQUESTED'), id: 3}]},
  });
  fake.fail('graphql:prefetch', new Error('down'));
  const {counters, log} = await runStale(fake, CONFLICTS);
  assert.equal(counters.resolved, 1);
  assert.ok(log.text().includes('error: GraphQL prefetch failed: down'));
  assert.equal(fake.count('rest.pulls.get'), 1);
});

test('invalid configuration rejects before any call', async () => {
  const fake = createFake();
  await assert.rejects(runStale(fake, {STALE_DRY_RUN: 'maybe'}), /STALE_DRY_RUN/);
  assert.equal(fake.calls.length, 0);
});
