const assert = require('node:assert/strict');
const { test } = require('node:test');
const resolveRelease = require('./resolve-release.cjs');

const head = 'b'.repeat(40);
const base = 'a'.repeat(40);

function fixture({ permission = 'write', state = 'open', repository = 'owner/repo', actor = 'maintainer' } = {}) {
  const outputs = {};
  const summary = { addHeading() { return this; }, addRaw() { return this; }, async write() {} };
  const requests = [];
  return {
    outputs,
    requests,
    args: {
      env: { RELEASE_PR: '123' },
      context: { sha: base, actor, repo: { owner: 'owner', repo: 'repo' } },
      core: { setOutput(key, value) { outputs[key] = value; }, summary },
      github: { rest: {
        repos: { async getCollaboratorPermissionLevel(request) { requests.push(request); return { data: { permission } }; } },
        pulls: { async get() { return { data: { state, head: { sha: head, repo: { full_name: repository } } } }; } },
      } },
    },
  };
}

test('PR builds pin the head SHA and isolate preview tags', async () => {
  const { args, outputs } = fixture();
  await resolveRelease(args);
  assert.deepEqual(outputs, { sha: head, tag: `runtime-pr-123-${head}`, pr: '123' });
});

test('main releases retain existing runtime URLs', async () => {
  const { args, outputs } = fixture();
  args.env = {};
  await resolveRelease(args);
  assert.deepEqual(outputs, { sha: base, tag: `runtime-${base}`, pr: '' });
});

test('unauthorized, closed, and fork PR requests are rejected', async () => {
  for (const options of [{ permission: 'read' }, { permission: 'triage' }, { state: 'closed' }, { repository: 'fork/repo' }]) {
    await assert.rejects(resolveRelease(fixture(options).args));
  }
});

test('label requests fail if the PR moved before the dispatch started', async () => {
  const { args } = fixture();
  args.env.RELEASE_HEAD_SHA = base;
  await assert.rejects(resolveRelease(args), /PR changed/);
});

test('bot dispatch revalidates the label requester', async () => {
  const { args, requests } = fixture({ actor: 'github-actions[bot]' });
  args.env.RELEASE_HEAD_SHA = head;
  args.env.RELEASE_REQUESTER = 'label-maintainer';
  await resolveRelease(args);
  assert.equal(requests[0].username, 'label-maintainer');
  const denied = fixture({ actor: 'github-actions[bot]', permission: 'read' });
  denied.args.env = args.env;
  await assert.rejects(resolveRelease(denied.args), /write access/);
});

test('manual users cannot impersonate the label requester', async () => {
  const { args, requests } = fixture({ actor: 'reader', permission: 'read' });
  args.env.RELEASE_HEAD_SHA = head;
  args.env.RELEASE_REQUESTER = 'admin';
  await assert.rejects(resolveRelease(args));
  assert.equal(requests[0].username, 'reader');
});

test('malformed PR numbers never reach the API', async () => {
  for (const number of ['0', '-1', '1;echo bad', '1.5', '1e2']) {
    const { args, requests } = fixture();
    args.env.RELEASE_PR = number;
    await assert.rejects(resolveRelease(args), /positive PR number/);
    assert.equal(requests.length, 0);
  }
});
