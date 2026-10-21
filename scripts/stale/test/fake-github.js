'use strict';

// In-memory stand-in for the Octokit client handed to actions/github-script.
//
// State (all plain data, set by the test):
//   issues    REST issue list items (PRs carry a `pull_request` key)
//   comments  {number: [comment]}   issues.listComments
//   events    {number: [event]}     issues.listEvents
//   reviews   {number: [review]}    pulls.listReviews
//   pulls     {number: pull}        pulls.get (REST fallback)
//   commits   {sha: commit}         repos.getCommit
//   prs       [GraphQL PR node]     paged prefetch and aliased refresh queries
//
// A GraphQL node's `mergeable` may be an array: each read consumes the first
// entry until one is left, which models UNKNOWN turning into a known state.
//
// Every call is recorded in `calls` as {name, params}. Failures are injected
// with `fail(name, error, {times, match})`.

const WRITES = [
  'rest.issues.createComment',
  'rest.issues.addLabels',
  'rest.issues.removeLabel',
  'rest.issues.update',
  'rest.pulls.createReview',
  'rest.pulls.dismissReview',
];

function createFake(initial = {}) {
  const state = {
    issues: [],
    comments: {},
    events: {},
    reviews: {},
    pulls: {},
    commits: {},
    prs: [],
    pageSize: 50,
    ...initial,
  };
  const calls = [];
  const failures = [];

  function fail(name, error, {times = Infinity, match = () => true} = {}) {
    failures.push({name, error, times, match});
  }

  function record(name, params) {
    calls.push({name, params});
    for (const f of failures) {
      if (f.name === name && f.times > 0 && f.match(params)) {
        f.times--;
        throw f.error;
      }
    }
  }

  function endpoint(name, impl) {
    const fn = async params => {
      record(name, params);
      return impl(params);
    };
    fn.endpointName = name;
    return fn;
  }

  const paginated = {
    'rest.issues.listForRepo': () => state.issues,
    'rest.issues.listComments': p => state.comments[p.issue_number] ?? [],
    'rest.issues.listEvents': p => state.events[p.issue_number] ?? [],
    'rest.pulls.listReviews': p => state.reviews[p.pull_number] ?? [],
  };

  const rest = {
    issues: {
      listForRepo: endpoint('rest.issues.listForRepo', () => ({data: state.issues})),
      listComments: endpoint('rest.issues.listComments', () => ({data: []})),
      listEvents: endpoint('rest.issues.listEvents', () => ({data: []})),
      createComment: endpoint('rest.issues.createComment', () => ({data: {}})),
      addLabels: endpoint('rest.issues.addLabels', () => ({data: []})),
      removeLabel: endpoint('rest.issues.removeLabel', () => ({data: []})),
      update: endpoint('rest.issues.update', () => ({data: {}})),
    },
    pulls: {
      get: endpoint('rest.pulls.get', p => {
        const data = state.pulls[p.pull_number];
        if (!data) throw new Error(`pulls.get: no pull #${p.pull_number}`);
        const out = {...data};
        if (Array.isArray(out.mergeable)) {
          out.mergeable = out.mergeable.length > 1 ? out.mergeable.shift() : out.mergeable[0];
        }
        return {data: out};
      }),
      listReviews: endpoint('rest.pulls.listReviews', () => ({data: []})),
      createReview: endpoint('rest.pulls.createReview', () => ({data: {}})),
      dismissReview: endpoint('rest.pulls.dismissReview', () => ({data: {}})),
    },
    repos: {
      getCommit: endpoint('rest.repos.getCommit', p => {
        const data = state.commits[p.ref];
        if (!data) throw new Error(`getCommit: no commit ${p.ref}`);
        return {data};
      }),
    },
  };

  async function paginate(fn, params) {
    record(`paginate:${fn.endpointName}`, params);
    return paginated[fn.endpointName](params);
  }

  function readMergeable(node) {
    if (!Array.isArray(node.mergeable)) return node.mergeable;
    return node.mergeable.length > 1 ? node.mergeable.shift() : node.mergeable[0];
  }

  function prefetchPage(vars) {
    const start = vars.cursor ? Number(vars.cursor) : 0;
    const slice = state.prs.slice(start, start + state.pageSize);
    const end = start + slice.length;
    return {
      repository: {
        pullRequests: {
          pageInfo: {hasNextPage: end < state.prs.length, endCursor: String(end)},
          nodes: slice.map(node => {
            const out = {...node};
            if (vars.withMergeable) {
              out.mergeable = readMergeable(node);
            } else {
              delete out.mergeable;
            }
            if (!vars.withCommits) delete out.commits;
            return out;
          }),
        },
      },
    };
  }

  function refreshPage(query) {
    const repository = {};
    for (const [, n] of query.matchAll(/pr(\d+): pullRequest/g)) {
      const node = state.prs.find(p => p.number === Number(n));
      repository[`pr${n}`] = node ? {number: node.number, mergeable: readMergeable(node)} : null;
    }
    return {repository};
  }

  async function graphql(query, vars) {
    const kind = query.includes('pullRequests(') ? 'prefetch' : 'refresh';
    record(`graphql:${kind}`, {query, vars});
    return kind === 'prefetch' ? prefetchPage(vars) : refreshPage(query);
  }

  return {
    rest,
    paginate,
    graphql,
    state,
    calls,
    fail,
    named: name => calls.filter(c => c.name === name),
    count: name => calls.filter(c => c.name === name).length,
    writes: () => calls.filter(c => WRITES.includes(c.name)),
  };
}

// Builders. Times are given as days before NOW.
const NOW = new Date('2026-06-01T00:00:00.000Z');
const ago = days => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function issue(number, {
  labels = [],
  updated = 1,
  created = 200,
  locked = false,
  pr = false,
  user = 'alice',
} = {}) {
  const item = {
    number,
    locked,
    labels: labels.map(name => ({name})),
    user: {login: user, type: 'User'},
    updated_at: ago(updated),
    created_at: ago(created),
  };
  if (pr) item.pull_request = {};
  return item;
}

function node(number, {
  labels = [],
  updated = 1,
  created = 200,
  locked = false,
  mergeable,
  author = {__typename: 'User', login: 'alice'},
  head = {oid: `sha${number}`, committedDate: ago(200)},
} = {}) {
  const out = {
    number,
    locked,
    updatedAt: ago(updated),
    createdAt: ago(created),
    headRefOid: `sha${number}`,
    author,
    labels: {nodes: labels.map(name => ({name}))},
    commits: {nodes: head ? [{commit: head}] : []},
  };
  if (mergeable !== undefined) out.mergeable = mergeable;
  return out;
}

const comment = (login, createdDaysAgo, type = 'User') => ({
  user: {login, type},
  created_at: ago(createdDaysAgo),
});
const labeled = (name, daysAgo) => ({event: 'labeled', label: {name}, created_at: ago(daysAgo)});
const review = (login, state, extra = {}) => ({user: {login, type: 'User'}, state, ...extra});

module.exports = {createFake, NOW, ago, issue, node, comment, labeled, review};
