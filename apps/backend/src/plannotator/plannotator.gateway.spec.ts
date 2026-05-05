import { PlannotatorGateway } from './plannotator.gateway.js';

describe('PlannotatorGateway', () => {
  const panel = {
    sessionId: 7,
    url: 'http://127.0.0.1:19432/',
    proxyUrl: '/api/plannotator/proxy/19432/',
    upstreamPort: 19432,
    mode: 'plan' as const,
    openedAt: '2026-05-06T00:00:00.000Z',
  };

  let registry: {
    handleClientClose: jest.Mock;
    handleProxyClose: jest.Mock;
  };
  let sessionWatcher: {
    terminateSessionByPort: jest.Mock;
  };
  let gateway: PlannotatorGateway;

  beforeEach(() => {
    registry = {
      handleClientClose: jest.fn(),
      handleProxyClose: jest.fn(),
    };
    sessionWatcher = {
      terminateSessionByPort: jest.fn(),
    };
    gateway = new PlannotatorGateway(
      {} as never,
      {} as never,
      registry as never,
      sessionWatcher as never,
    );
  });

  it('terminates the plannotator process when a client closes a panel', () => {
    registry.handleClientClose.mockReturnValue(panel);
    const client = { emit: jest.fn() };

    gateway.handleClosePanel(client as never, { sessionId: panel.sessionId });

    expect(registry.handleClientClose).toHaveBeenCalledWith(panel.sessionId);
    expect(sessionWatcher.terminateSessionByPort).toHaveBeenCalledWith(panel.upstreamPort);
    expect(client.emit).toHaveBeenCalledWith('panel-closed', { sessionId: panel.sessionId });
  });

  it('does not terminate a process when client close has no active panel', () => {
    registry.handleClientClose.mockReturnValue(null);
    const client = { emit: jest.fn() };

    gateway.handleClosePanel(client as never, { sessionId: panel.sessionId });

    expect(sessionWatcher.terminateSessionByPort).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('panel-closed', { sessionId: panel.sessionId });
  });

  it('terminates the plannotator process when the proxied page requests close', () => {
    (gateway as unknown as { handleProxyClose: (upstreamPort: number) => void }).handleProxyClose(
      panel.upstreamPort,
    );

    expect(registry.handleProxyClose).toHaveBeenCalledWith(panel.upstreamPort);
    expect(sessionWatcher.terminateSessionByPort).toHaveBeenCalledWith(panel.upstreamPort);
  });
});
