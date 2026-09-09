import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import type { RemoteLinkDeviceState, RemoteLinkStatus } from '@/shared/runtime/electron-remote-link';

import { RemoteLinkService } from './remote-link.service';

function device(overrides: Partial<RemoteLinkDeviceState> = {}): RemoteLinkDeviceState {
  return {
    id: 3,
    name: 'Studio',
    transport: 'p2p',
    endpoint: '',
    createdAt: '2024-01-01',
    lastConnectedAt: '2024-01-01',
    status: 'connected',
    localPort: 51234,
    backendUrl: 'http://127.0.0.1:51234',
    path: 'direct',
    error: null,
    ...overrides,
  };
}

describe('RemoteLinkService', () => {
  let emitStatus: (state: RemoteLinkDeviceState) => void;

  const api = {
    getSharing: vi.fn(async () => ({
      configured: false,
      enabled: false,
      transport: null,
      endpoint: null,
      label: '',
      status: 'stopped' as RemoteLinkStatus,
      connectedPeers: 0,
      error: null,
    })),
    list: vi.fn(async () => [device()]),
    connect: vi.fn(async () => device()),
    onSharingChanged: vi.fn(() => () => undefined),
    onStatusChanged: vi.fn((callback: (state: RemoteLinkDeviceState) => void) => {
      emitStatus = callback;
      return () => undefined;
    }),
  };

  const onboardingStateMock = {
    paired: { id: 3, name: 'Studio', localPort: 51234 } as { id: number; name: string; localPort: number } | null,
    getPairedState: vi.fn(() => onboardingStateMock.paired),
    setPairedState: vi.fn(),
    markPairedConnected: vi.fn(),
    clearPairedConnection: vi.fn(),
  };

  function createService(): RemoteLinkService {
    TestBed.configureTestingModule({
      providers: [
        RemoteLinkService,
        { provide: OnboardingStateService, useValue: onboardingStateMock },
      ],
    });
    return TestBed.inject(RemoteLinkService);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    onboardingStateMock.paired = { id: 3, name: 'Studio', localPort: 51234 };
    (window as unknown as { __ELEVENEX_ELECTRON__?: unknown }).__ELEVENEX_ELECTRON__ = {
      remoteLink: api,
    };
  });

  it('re-arms the window backend when the link comes back on its own', () => {
    createService();

    emitStatus(device({ status: 'reconnecting', localPort: 51234 }));
    expect(onboardingStateMock.clearPairedConnection).toHaveBeenCalled();

    emitStatus(device({ status: 'connected', localPort: 51234 }));
    expect(onboardingStateMock.markPairedConnected).toHaveBeenCalledWith({
      id: 3,
      name: 'Studio',
      localPort: 51234,
    });
  });

  it('leaves another device alone', () => {
    createService();

    emitStatus(device({ id: 9, status: 'reconnecting' }));

    expect(onboardingStateMock.clearPairedConnection).not.toHaveBeenCalled();
    expect(onboardingStateMock.markPairedConnected).not.toHaveBeenCalled();
  });

  it('refuses to point the window at a port whose link is not up', async () => {
    api.connect.mockResolvedValueOnce(
      device({ status: 'reconnecting', error: 'The link dropped.' }),
    );
    const service = createService();

    await expect(service.connect(3)).rejects.toThrow('The link dropped.');
    expect(onboardingStateMock.setPairedState).not.toHaveBeenCalled();
  });

  it('points the window at a connected link', async () => {
    const service = createService();

    await service.connect(3);

    expect(onboardingStateMock.setPairedState).toHaveBeenCalledWith({
      id: 3,
      name: 'Studio',
      localPort: 51234,
    });
  });
});
