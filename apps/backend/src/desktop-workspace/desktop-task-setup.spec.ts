import { desktopTaskSetupIssue } from './desktop-task-setup.js';

describe('Desktop task setup display boundary', () => {
  it('explains the workspace quota without forwarding raw errors', () => {
    const issue = desktopTaskSetupIssue({
      code: 'worktree_limit_reached',
      count: 23,
      limit: 5,
      message: 'private output',
    });
    expect(issue).toMatchObject({
      code: 'other',
      canUseSnapshot: false,
      canExceedWorktreeLimit: true,
    });
    expect(issue?.message).toContain('23 workspaces');
    expect(issue?.message).toContain('limit of 5');
    expect(JSON.stringify(issue)).not.toContain('private');
  });
  it.each([
    {},
    { count: '<private>', limit: 5 },
    { count: -1, limit: 5 },
    { count: 2, limit: 5 },
    { count: 1, limit: 0 },
  ])('bounds malformed quota display values: %s', (quota) => {
    const issue = desktopTaskSetupIssue({
      code: 'worktree_limit_reached',
      ...quota,
    });
    expect(issue?.message).toContain('has reached its workspace limit');
    expect(issue?.message).not.toContain('private');
  });
  it('exposes the recovery choices and path while dropping private setup details', () => {
    const issue = desktopTaskSetupIssue(
      JSON.stringify({
        code: 'external_checkout',
        path: '/work/existing',
        canSnapshot: true,
        message: 'Private command output',
        token: 'private',
      }),
    );
    expect(issue).toMatchObject({
      code: 'external-checkout',
      workspacePath: '/work/existing',
      canUseSnapshot: true,
    });
    expect(issue?.message).toContain('already checked out');
    expect(JSON.stringify(issue)).not.toMatch(/Private|private|token/);
  });
  it.each([null, undefined])('omits absent failure metadata: %s', (value) =>
    expect(desktopTaskSetupIssue(value)).toBeUndefined(),
  );
  it.each([
    'not json',
    'x'.repeat(20000),
    { code: 'unknown', canSnapshot: true, message: 'secret' },
  ])(
    'uses safe generic feedback for malformed or unsupported errors',
    (value) => {
      expect(desktopTaskSetupIssue(value)).toMatchObject({
        code: 'other',
        canUseSnapshot: false,
      });
      expect(JSON.stringify(desktopTaskSetupIssue(value))).not.toContain(
        'secret',
      );
    },
  );
  it('never advertises external checkout consent for a busy or owned branch', () => {
    expect(
      desktopTaskSetupIssue({ code: 'branch_in_use', canSnapshot: true }),
    ).toMatchObject({ code: 'branch-in-use', canUseSnapshot: true });
    expect(
      desktopTaskSetupIssue({ code: 'environment_busy', canSnapshot: true }),
    ).toMatchObject({ code: 'environment-busy', canUseSnapshot: true });
    expect(
      desktopTaskSetupIssue({
        code: 'external_checkout',
        path: '/work/\ninvalid',
      })?.workspacePath,
    ).toBeUndefined();
  });
});
