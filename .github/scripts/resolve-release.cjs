module.exports = async function resolveRelease({ github, context, core, env = process.env }) {
  const request = (env.RELEASE_PR || '').trim();
  let sha = context.sha;
  let pr = '';
  if (request) {
    if (!/^[1-9]\d*$/.test(request)) throw new Error('Enter a positive PR number.');
    const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...context.repo, username: context.actor === 'github-actions[bot]' && env.RELEASE_HEAD_SHA
        ? env.RELEASE_REQUESTER || context.actor : context.actor,
    });
    if (!['admin', 'maintain', 'write'].includes(permission.permission)) {
      throw new Error('Only collaborators with write access can request signed PR releases.');
    }
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(request) });
    if (pull.state !== 'open') throw new Error('Only open PRs can be released.');
    if (pull.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`) {
      throw new Error('Signed previews require a branch in this repository. Review and copy fork changes to a repository branch first.');
    }
    if (env.RELEASE_HEAD_SHA && env.RELEASE_HEAD_SHA !== pull.head.sha) {
      throw new Error('The PR changed after this request. Request a new preview for its current head.');
    }
    sha = pull.head.sha;
    pr = request;
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Release commit must be a full Git SHA.');
  const tag = pr ? `runtime-pr-${pr}-${sha}` : `runtime-${sha}`;
  core.setOutput('sha', sha);
  core.setOutput('tag', tag);
  core.setOutput('pr', pr);
  await core.summary.addHeading(pr ? `PR #${pr} preview` : 'Release')
    .addRaw(`Commit: ${sha}\n\nTag: ${tag}\n`).write();
};
