'use strict';

const run = require('../index');
const {NOW} = require('./fake-github');

const BASE_ENV = {
  STALE_DAYS_BEFORE_STALE: '90',
  STALE_DAYS_BEFORE_STALE_CONFLICTING: '0',
  STALE_DAYS_BEFORE_CLOSE: '7',
  STALE_LABEL: 'stale',
  STALE_EXEMPT_LABEL: 'not-stale',
  STALE_CONFLICT_LABEL: 'needs-rebase',
  STALE_PR_MESSAGE: 'pr stale',
  STALE_CONFLICT_PR_MESSAGE: 'pr conflict',
  STALE_CONFLICTING_PR_MESSAGE: 'pr stale conflicting',
  STALE_ISSUE_MESSAGE: 'issue stale',
  STALE_IGNORED_USERS: '',
  STALE_CONFLICTS_ONLY: 'false',
  STALE_DRY_RUN: 'false',
  STALE_BOT_LOGIN: 'esphome[bot]',
};

function makeLog() {
  const lines = [];
  return {
    lines,
    log: m => lines.push(['log', m]),
    warn: m => lines.push(['warn', m]),
    error: m => lines.push(['error', m]),
    text: () => lines.map(([level, m]) => `${level}: ${m}`),
  };
}

function makeCore() {
  const failures = [];
  return {failures, setFailed: m => failures.push(m)};
}

// Run the whole script against a fake client and return everything observable
async function runStale(fake, envOverrides = {}) {
  const log = makeLog();
  const core = makeCore();
  const sleeps = [];
  const counters = await run({
    github: fake,
    context: {repo: {owner: 'o', repo: 'r'}},
    core,
    env: {...BASE_ENV, ...envOverrides},
    now: NOW,
    sleep: async ms => { sleeps.push(ms); },
    log,
  });
  return {counters, log, core, sleeps};
}

module.exports = {BASE_ENV, makeLog, makeCore, runStale};

// A context object as index.js builds it, for testing modules directly
function makeCtx(fake, envOverrides = {}) {
  const {readConfig} = require('../config');
  return {
    github: fake,
    owner: 'o',
    repo: 'r',
    config: readConfig({...BASE_ENV, ...envOverrides}, NOW),
    sleep: async () => {},
    log: makeLog(),
    pulls: new Map(),
    prs: new Map(),
    prefetchFailed: false,
  };
}

module.exports.makeCtx = makeCtx;
