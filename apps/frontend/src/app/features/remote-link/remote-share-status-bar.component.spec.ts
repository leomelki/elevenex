import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import type { RemoteLinkSharingState } from '@/shared/runtime/electron-remote-link';

import { RemoteShareStatusBarComponent } from './remote-share-status-bar.component';

function sharing(overrides: Partial<RemoteLinkSharingState> = {}): RemoteLinkSharingState {
  return {
    configured: true,
    enabled: true,
    transport: 'p2p',
    endpoint: null,
    label: '',
    createdAt: '2024-01-01',
    status: 'connected',
    connectedPeers: 1,
    error: null,
    ...overrides,
  };
}

describe('RemoteShareStatusBarComponent', () => {
  let emitSharing: (state: RemoteLinkSharingState) => void;

  const api = {
    getSharing: vi.fn(async () => sharing({ enabled: false, status: 'stopped', connectedPeers: 0 })),
    list: vi.fn(async () => []),
    disableSharing: vi.fn(async () => sharing({ enabled: false, status: 'stopped', connectedPeers: 0 })),
    onSharingChanged: vi.fn((callback: (state: RemoteLinkSharingState) => void) => {
      emitSharing = callback;
      return () => undefined;
    }),
    onStatusChanged: vi.fn(() => () => undefined),
  };

  const onboardingStateMock = {
    getPairedState: vi.fn(() => null),
    setPairedState: vi.fn(),
    markPairedConnected: vi.fn(),
    clearPairedConnection: vi.fn(),
  };

  async function render() {
    TestBed.configureTestingModule({
      imports: [RemoteShareStatusBarComponent],
      providers: [{ provide: OnboardingStateService, useValue: onboardingStateMock }],
    });
    const fixture = TestBed.createComponent(RemoteShareStatusBarComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    (window as unknown as { __ELEVENEX_ELECTRON__?: unknown }).__ELEVENEX_ELECTRON__ = {
      remoteLink: api,
    };
  });

  it('stays hidden while sharing is on but nobody is connected', async () => {
    const fixture = await render();
    emitSharing(sharing({ status: 'waiting', connectedPeers: 0 }));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.remote-share-bar')).toBeNull();
  });

  it('announces a single connected paired desktop', async () => {
    const fixture = await render();
    emitSharing(sharing());
    fixture.detectChanges();

    const band = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.remote-share-bar');
    expect(band?.getAttribute('role')).toBe('status');
    expect(band?.textContent).toContain('A paired desktop is remotely connected to this machine');
  });

  it('pluralizes when several paired desktops are connected', async () => {
    const fixture = await render();
    emitSharing(sharing({ connectedPeers: 2 }));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.remote-share-bar')?.textContent).toContain(
      '2 paired desktops are remotely connected to this machine',
    );
  });

  it('disappears when the last peer drops', async () => {
    const fixture = await render();
    emitSharing(sharing({ status: 'waiting', connectedPeers: 0 }));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.remote-share-bar')).toBeNull();
  });

  it('stops sharing from the band', async () => {
    const fixture = await render();
    emitSharing(sharing());
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.remote-share-bar button')
      ?.click();
    await vi.waitFor(() => expect(api.disableSharing).toHaveBeenCalled());
  });
});
