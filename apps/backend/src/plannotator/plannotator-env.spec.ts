import { buildManagedPlannotatorEnv } from './plannotator-env.js';

describe('buildManagedPlannotatorEnv', () => {
  const originalProxyPort = process.env.ELEVENEX_PROXY_PORT;

  afterEach(() => {
    if (originalProxyPort === undefined) {
      delete process.env.ELEVENEX_PROXY_PORT;
    } else {
      process.env.ELEVENEX_PROXY_PORT = originalProxyPort;
    }
  });

  it('forces local plannotator mode so managed sessions use random upstream ports and open the wrapper', () => {
    process.env.ELEVENEX_PROXY_PORT = '25000';

    const env = buildManagedPlannotatorEnv(42, '/tmp/plannotator-wrapper.sh', {
      PATH: '/usr/bin',
      PLANNOTATOR_REMOTE: '1',
      PLANNOTATOR_PORT: '19432',
      SSH_TTY: '/dev/ttys001',
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      ELEVENEX_SESSION_ID: '42',
      ELEVENEX_PORT: '25000',
      PLANNOTATOR_BROWSER: '/tmp/plannotator-wrapper.sh',
      PLANNOTATOR_REMOTE: '0',
      SSH_TTY: '/dev/ttys001',
    });
    expect(env.PLANNOTATOR_PORT).toBeUndefined();
  });
});
