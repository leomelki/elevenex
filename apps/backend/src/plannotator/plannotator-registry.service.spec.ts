import { Test, TestingModule } from '@nestjs/testing';
import { CookieProxyService } from './cookie-proxy.service.js';
import { PlannotatorRegistryService } from './plannotator-registry.service.js';

describe('PlannotatorRegistryService', () => {
  let service: PlannotatorRegistryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlannotatorRegistryService,
        {
          provide: CookieProxyService,
          useValue: {
            rewriteUrl: jest.fn((url: string) => ({
              proxyUrl: `/api/plannotator/proxy/19432/?source=${encodeURIComponent(url)}`,
              upstreamPort: 19432,
            })),
            initUpstreamCookies: jest.fn(),
            clearUpstream: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(PlannotatorRegistryService);
  });

  it('opens a panel for an active launch', () => {
    service.registerLaunch(7, '/tmp/worktree');

    const result = service.registerOpen({
      sessionId: 7,
      url: 'http://127.0.0.1:19432/?mode=review',
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 7,
      upstreamPort: 19432,
      proxyUrl: '/api/plannotator/proxy/19432/?source=http%3A%2F%2F127.0.0.1%3A19432%2F%3Fmode%3Dreview',
    });
    expect(service.getActivePanels()[0]?.mode).toBe('review');
  });

  it('rejects an open without an active launch', () => {
    expect(
      service.registerOpen({
        sessionId: 9,
        url: 'http://127.0.0.1:19432/',
      }),
    ).toEqual({
      ok: false,
      reason: 'session-not-active',
    });
  });

  it('rejects reopen after close in the same generation', () => {
    service.registerLaunch(11, '/tmp/worktree');
    service.registerOpen({ sessionId: 11, url: 'http://127.0.0.1:19432/' });
    expect(service.registerClose({ sessionId: 11, upstreamPort: 19432 })).toBe(true);

    expect(
      service.registerOpen({
        sessionId: 11,
        url: 'http://127.0.0.1:19432/',
      }),
    ).toEqual({
      ok: false,
      reason: 'panel-closed-for-current-launch',
    });
  });

  it('allows reopen after a new launch generation', () => {
    service.registerLaunch(13, '/tmp/worktree');
    service.registerOpen({ sessionId: 13, url: 'http://127.0.0.1:19432/' });
    service.registerClose({ sessionId: 13, upstreamPort: 19432 });

    service.registerLaunch(13, '/tmp/worktree');
    const result = service.registerOpen({
      sessionId: 13,
      url: 'http://127.0.0.1:19432/?mode=archive',
    });

    expect(result.ok).toBe(true);
    expect(service.getActivePanels()[0]?.mode).toBe('archive');
  });

  it('allows discovered sessions to attach without an active launch', () => {
    const result = service.registerDiscoveredOpen({
      sessionId: 21,
      url: 'http://127.0.0.1:19432/?mode=annotate',
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 21,
      upstreamPort: 19432,
      proxyUrl:
        '/api/plannotator/proxy/19432/?source=http%3A%2F%2F127.0.0.1%3A19432%2F%3Fmode%3Dannotate',
    });
    expect(service.getActivePanels()[0]?.mode).toBe('annotate');
    expect(service.getSessionIdByUpstreamPort(19432)).toBe(21);
  });
});
