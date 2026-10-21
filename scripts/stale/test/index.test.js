'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const run = require('../index');
const {createFake} = require('./fake-github');
const {BASE_ENV, makeLog} = require('./harness');

test('run defaults to the real environment, clock, timers and console', async () => {
  const saved = {};
  for (const [k, v] of Object.entries(BASE_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const lines = [];
  const original = console.log;
  console.log = m => lines.push(m);
  try {
    const counters = await run({
      github: createFake(),
      context: {repo: {owner: 'o', repo: 'r'}},
      core: {setFailed: () => assert.fail('unexpected failure')},
    });
    assert.equal(counters.marked, 0);
  } finally {
    console.log = original;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.ok(lines.some(l => l.startsWith('Will mark items without real activity since: ')));
});

test('the default sleep really waits', async () => {
  const fake = createFake({prs: []});
  fake.fail('graphql:prefetch', new Error('x'), {times: 1});
  const realSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
  try {
    await run({
      github: fake,
      context: {repo: {owner: 'o', repo: 'r'}},
      core: {},
      env: BASE_ENV,
      log: makeLog(),
    });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepEqual(delays, [5000]);
});
