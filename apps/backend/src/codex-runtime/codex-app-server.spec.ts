import { CodexAppServerClient } from './codex-app-server.js';
import { codexBinaryIdentity } from './codex-binary.js';

jest.mock('./codex-binary.js', () => ({
  resolveCodexBinary: jest.fn(() => '/mock/codex'),
  codexBinaryIdentity: jest.fn(),
}));

describe('Codex CLI replacement', () => {
  beforeEach(() => jest.resetAllMocks());

  it('preserves the prewarmed process when a model refresh finds the same CLI', async () => {
    const server = new CodexAppServerClient();
    const child = { killed: false, kill: jest.fn() };
    const initialized = Promise.resolve();
    Object.assign(server, { child, binaryIdentity: 'same-cli', initializePromise: initialized });
    jest.mocked(codexBinaryIdentity).mockResolvedValue('same-cli');
    await server.restartIfBinaryChanged();
    expect(child.kill).not.toHaveBeenCalled();
    expect((server as any).child).toBe(child);
    expect((server as any).initializePromise).toBe(initialized);
    expect((server as any).restartPending).toBe(false);
  });

  it('defers replacement of an updated CLI until an active turn releases the server', async () => {
    const server = new CodexAppServerClient();
    const child = { killed: false, kill: jest.fn() };
    Object.assign(server, { child, binaryIdentity: 'old-cli' });
    jest.mocked(codexBinaryIdentity).mockResolvedValue('updated-cli');
    server.addRef();
    await server.restartIfBinaryChanged();
    expect(child.kill).not.toHaveBeenCalled();
    server.release();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    server.onModuleDestroy();
  });

  it('does not discard a warm server when the executable cannot be inspected', async () => {
    const server = new CodexAppServerClient();
    const child = { killed: false, kill: jest.fn() };
    Object.assign(server, { child, binaryIdentity: 'current-cli' });
    jest.mocked(codexBinaryIdentity).mockResolvedValue(null);
    await server.restartIfBinaryChanged();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('waits for active turns to release their references before closing the old process', () => {
    const server = new CodexAppServerClient();
    const child = { killed: false, kill: jest.fn() };
    (server as any).child = child;
    server.addRef();
    server.addRef();
    server.restartWhenIdle();
    expect(child.kill).not.toHaveBeenCalled();
    server.release();
    expect(child.kill).not.toHaveBeenCalled();
    server.release();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect((server as any).child).toBeNull();
    server.onModuleDestroy();
  });

  it('does not terminate an outstanding request even when no turn holds a reference', () => {
    const server = new CodexAppServerClient();
    const child = { killed: false, kill: jest.fn() };
    (server as any).child = child;
    (server as any).pending.set(1, {});
    server.restartWhenIdle();
    expect(child.kill).not.toHaveBeenCalled();
    (server as any).pending.clear();
    (server as any).restartIfIdle();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
