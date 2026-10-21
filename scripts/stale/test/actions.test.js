'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../actions');
const {createFake, review} = require('./fake-github');
const {makeCtx} = require('./harness');

test('removeLabel and addLabel call the label endpoints', async () => {
  const fake = createFake();
  const ctx = makeCtx(fake);
  await actions.removeLabel(ctx, {number: 4}, 'stale');
  await actions.addLabel(ctx, {number: 4}, 'needs-rebase');
  assert.deepEqual(fake.writes(), [
    {name: 'rest.issues.removeLabel', params: {owner: 'o', repo: 'r', issue_number: 4, name: 'stale'}},
    {name: 'rest.issues.addLabels', params: {owner: 'o', repo: 'r', issue_number: 4, labels: ['needs-rebase']}},
  ]);
});

test('markStale comments before labelling', async () => {
  const fake = createFake();
  await actions.markStale(makeCtx(fake), {number: 5}, 'hello');
  assert.deepEqual(fake.writes().map(c => c.name), ['rest.issues.createComment', 'rest.issues.addLabels']);
  assert.equal(fake.writes()[0].params.body, 'hello');
  assert.deepEqual(fake.writes()[1].params.labels, ['stale']);
});

test('markStale does not label when the comment fails', async () => {
  const fake = createFake();
  fake.fail('rest.issues.createComment', new Error('boom'));
  await assert.rejects(actions.markStale(makeCtx(fake), {number: 5}, 'hello'), /boom/);
  assert.equal(fake.count('rest.issues.addLabels'), 0);
});

test('requestConflictChanges submits a review for other authors', async () => {
  const fake = createFake();
  await actions.requestConflictChanges(makeCtx(fake), {number: 6, user: {login: 'alice'}});
  assert.deepEqual(fake.writes(), [{
    name: 'rest.pulls.createReview',
    params: {owner: 'o', repo: 'r', pull_number: 6, event: 'REQUEST_CHANGES', body: 'pr conflict'},
  }]);
});

test('requestConflictChanges tolerates a missing author', async () => {
  const fake = createFake();
  await actions.requestConflictChanges(makeCtx(fake), {number: 6});
  assert.equal(fake.count('rest.pulls.createReview'), 1);
});

test('requestConflictChanges comments on the bot\'s own PRs', async () => {
  const fake = createFake();
  await actions.requestConflictChanges(makeCtx(fake), {number: 6, user: {login: 'esphome[bot]'}});
  assert.deepEqual(fake.writes(), [{
    name: 'rest.issues.createComment',
    params: {owner: 'o', repo: 'r', issue_number: 6, body: 'pr conflict'},
  }]);
});

test('dismissConflictReviews only dismisses the bot\'s CHANGES_REQUESTED reviews', async () => {
  const fake = createFake({
    reviews: {
      7: [
        {...review('esphome[bot]', 'CHANGES_REQUESTED'), id: 1},
        {...review('esphome[bot]', 'DISMISSED'), id: 2},
        {...review('alice', 'CHANGES_REQUESTED'), id: 3},
        {id: 4, state: 'CHANGES_REQUESTED'},
        {...review('esphome[bot]', 'CHANGES_REQUESTED'), id: 5},
      ],
    },
  });
  await actions.dismissConflictReviews(makeCtx(fake), {number: 7});
  assert.deepEqual(fake.writes().map(c => c.params.review_id), [1, 5]);
  assert.equal(fake.writes()[0].params.message, 'The merge conflicts have been resolved.');
});

test('closeItem gives issues a close reason and PRs none', async () => {
  const fake = createFake();
  const ctx = makeCtx(fake);
  await actions.closeItem(ctx, {number: 8}, false);
  await actions.closeItem(ctx, {number: 9}, true);
  assert.deepEqual(fake.writes().map(c => c.params), [
    {owner: 'o', repo: 'r', issue_number: 8, state: 'closed', state_reason: 'not_planned'},
    {owner: 'o', repo: 'r', issue_number: 9, state: 'closed'},
  ]);
});
