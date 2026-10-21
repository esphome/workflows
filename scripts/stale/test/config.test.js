'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {readConfig} = require('../config');
const {BASE_ENV} = require('./harness');
const {NOW, ago} = require('./fake-github');

test('reads every setting and derives the cutoffs', () => {
  const config = readConfig({
    ...BASE_ENV,
    STALE_DAYS_BEFORE_STALE_CONFLICTING: '30',
    STALE_IGNORED_USERS: ' a, b ,,c ',
    STALE_CONFLICTS_ONLY: 'true',
    STALE_DRY_RUN: 'true',
  }, NOW);
  assert.equal(config.daysBeforeStale, 90);
  assert.equal(config.daysBeforeStaleConflicting, 30);
  assert.equal(config.daysBeforeClose, 7);
  assert.equal(config.staleLabel, 'stale');
  assert.equal(config.exemptLabel, 'not-stale');
  assert.equal(config.conflictLabel, 'needs-rebase');
  assert.equal(config.stalePrMessage, 'pr stale');
  assert.equal(config.conflictPrMessage, 'pr conflict');
  assert.equal(config.staleConflictingPrMessage, 'pr stale conflicting');
  assert.equal(config.staleIssueMessage, 'issue stale');
  assert.deepEqual([...config.ignoredUsers], ['a', 'b', 'c']);
  assert.equal(config.conflictsOnly, true);
  assert.equal(config.dryRun, true);
  assert.equal(config.botLogin, 'esphome[bot]');
  assert.equal(config.staleCutoff.toISOString(), ago(90));
  assert.equal(config.closeCutoff.toISOString(), ago(7));
  assert.equal(config.conflictCutoff.toISOString(), ago(30));
});

test('zero days-before-stale-conflicting disables the conflict cutoff', () => {
  const config = readConfig(BASE_ENV, NOW);
  assert.equal(config.conflictCutoff, null);
  assert.equal(config.conflictsOnly, false);
  assert.equal(config.dryRun, false);
});

test('missing ignored users is an empty set', () => {
  const env = {...BASE_ENV};
  delete env.STALE_IGNORED_USERS;
  assert.equal(readConfig(env, NOW).ignoredUsers.size, 0);
});

test('rejects non-numeric day counts', () => {
  for (const value of [undefined, '', '  ', 'abc', 'Infinity']) {
    assert.throws(
      () => readConfig({...BASE_ENV, STALE_DAYS_BEFORE_CLOSE: value}, NOW),
      /STALE_DAYS_BEFORE_CLOSE must be a number/,
    );
  }
});

test('rejects booleans that are not "true" or "false"', () => {
  for (const name of ['STALE_DRY_RUN', 'STALE_CONFLICTS_ONLY']) {
    for (const value of [undefined, '', 'yes', 'True']) {
      assert.throws(
        () => readConfig({...BASE_ENV, [name]: value}, NOW),
        new RegExp(`${name} must be "true" or "false"`),
      );
    }
  }
});
