import * as fs from 'node:fs';
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
        Object.defineProperty(process, 'platform', descriptor);
        if (shell === undefined) delete process.env.SHELL;
        else process.env.SHELL = shell;
      }
    },
  );
});
