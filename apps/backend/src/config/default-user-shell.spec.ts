import * as fs from 'node:fs';
import * as os from 'node:os';
import { getDefaultUserShell } from './system-paths.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('getDefaultUserShell platform fallback', () => {
  it.each([
    ['linux', '/bin/sh'],
    ['darwin', '/bin/zsh'],
  ])(
    'uses an available default on %s when SHELL is unset',
    (platform, expected) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const shell = process.env.SHELL;
      const account = jest
        .spyOn(jest.requireActual<typeof os>('os'), 'userInfo')
        .mockImplementation(() => {
          throw new Error('Account unavailable');
        });
      try {
        Object.defineProperty(process, 'platform', { value: platform });
        delete process.env.SHELL;
        expect(getDefaultUserShell()).toBe(expected);
        if (platform === 'linux')
          expect(() =>
            fs.accessSync('/bin/sh', fs.constants.X_OK),
          ).not.toThrow();
        process.env.SHELL = '/custom/shell';
        expect(getDefaultUserShell()).toBe('/custom/shell');
      } finally {
        account.mockRestore();
        Object.defineProperty(process, 'platform', descriptor);
        if (shell === undefined) delete process.env.SHELL;
        else process.env.SHELL = shell;
      }
    },
  );

  it('uses the account login shell when SHELL is missing', () => {
    const shell = process.env.SHELL;
    const account = jest
      .spyOn(jest.requireActual<typeof os>('os'), 'userInfo')
      .mockReturnValue({
        uid: 1000,
        gid: 1000,
        username: 'tester',
        homedir: '/home/tester',
        shell: '/custom/login-shell',
      });
    try {
      delete process.env.SHELL;
      expect(getDefaultUserShell()).toBe('/custom/login-shell');
      process.env.SHELL = '/explicit/shell';
      expect(getDefaultUserShell()).toBe('/explicit/shell');
    } finally {
      account.mockRestore();
      if (shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = shell;
    }
  });
});
