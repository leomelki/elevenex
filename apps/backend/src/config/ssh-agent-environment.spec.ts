import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshAgentEnvironment } from './ssh-agent-environment.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('remote SSH agent environment', () => {
  let root: string;
  let proxy: string;
  let agents: SshAgentEnvironment;
  let changes: number;
  const signal = () => new AbortController().signal;
  const publish = async (value: string) => {
    await writeFile(proxy + '.next', value);
    await rename(proxy + '.next', proxy + '.state');
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ex-shell-agent-'));
    proxy = join(root, 'agent.sock');
    changes = 0;
    await publish('0');
    agents = new SshAgentEnvironment(proxy, () => {
      changes++;
    });
  });
  afterEach(async () => {
    agents.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('presents an unset socket before conditional server shell startup when forwarding is absent', async () => {
    const env = { SSH_AUTH_SOCK: proxy, CUSTOM_BOOTSTRAP: 'keep' };
    await agents.prepare(env, signal());
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(Object.hasOwn(env, 'SSH_AUTH_SOCK')).toBe(false);
    expect(env.CUSTOM_BOOTSTRAP).toBe('keep');
    expect(changes).toBe(0);
  });

  it('preserves a real forwarded agent, coalesces readers, and notifies only on availability transitions', async () => {
    await publish('1');
    const envs = Array.from({ length: 100 }, () => ({ SSH_AUTH_SOCK: proxy }));
    await Promise.all(envs.map((env) => agents.prepare(env, signal())));
    expect(envs.every((env) => env.SSH_AUTH_SOCK === proxy)).toBe(true);
    expect(changes).toBe(0);
    await publish('1');
    await agents.prepare({}, signal());
    expect(changes).toBe(0);
    await publish('0');
    const env: NodeJS.ProcessEnv = { SSH_AUTH_SOCK: proxy };
    await agents.prepare(env, signal());
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(changes).toBe(1);
    expect(agents.generation).toBe(1);
    await publish('1');
    await agents.prepare(env, signal());
    expect(env.SSH_AUTH_SOCK).toBe(proxy);
    expect(changes).toBe(2);
  });

  it('observes atomic replacement without requiring a command or a shell capture', async () => {
    await agents.prepare({}, signal());
    await publish('1');
    const deadline = Date.now() + 3000;
    while (!changes && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(changes).toBe(1);
    expect(agents.socket).toBe(proxy);
  });

  it.each(['', '11', 'x'])(
    'rejects malformed state %j instead of warming an invented environment',
    async (value) => {
      await publish(value);
      await expect(agents.prepare({}, signal())).rejects.toThrow(
        'Invalid managed SSH agent state',
      );
    },
  );

  it('rejects symlinks and missing state and cleans up cancellation', async () => {
    const actual = join(root, 'actual');
    await writeFile(actual, '1');
    await rm(proxy + '.state');
    await symlink(actual, proxy + '.state');
    await expect(agents.prepare({}, signal())).rejects.toThrow();
    expect(await readFile(actual, 'utf8')).toBe('1');
    await rm(proxy + '.state');
    await expect(agents.prepare({}, signal())).rejects.toThrow();
    await publish('0');
    const controller = new AbortController();
    controller.abort();
    await expect(agents.prepare({}, controller.signal)).rejects.toThrow();
    agents.dispose();
    await expect(agents.prepare({}, signal())).rejects.toThrow('shutting down');
  });

  it('leaves standalone and legacy launch environments alone', async () => {
    const unmanaged = new SshAgentEnvironment(undefined, () => {
      throw new Error('Unexpected invalidation');
    });
    const env = { SSH_AUTH_SOCK: '/custom/agent.sock' };
    try {
      await unmanaged.prepare(env, signal());
      expect(env.SSH_AUTH_SOCK).toBe('/custom/agent.sock');
    } finally {
      unmanaged.dispose();
    }
  });
});
