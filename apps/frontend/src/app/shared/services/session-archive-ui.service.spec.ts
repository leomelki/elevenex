import { Component, DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionActivity, ClaudeStatusService } from './claude-status.service';
import { SessionArchiveUiService } from './session-archive-ui.service';

@Component({ template: '' })
class ArchiveOwner {}

describe('Inline session archive confirmation', () => {
  const getActivity = vi.fn<(id: number) => ClaudeSessionActivity | null>();
  let service: SessionArchiveUiService;
  let owner: DestroyRef;
  let archive: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    getActivity.mockReset().mockReturnValue({
      activityStatus: 'running',
      backgroundActive: false,
      actionKind: null,
      actionLabel: null,
    });
    TestBed.configureTestingModule({
      providers: [{ provide: ClaudeStatusService, useValue: { getKnownActivity: getActivity } }],
    });
    service = TestBed.inject(SessionArchiveUiService);
    owner = TestBed.createComponent(ArchiveOwner).componentRef.injector.get(DestroyRef);
    archive = vi.fn();
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://first-backend.test' };
  });

  afterEach(() => {
    service.cancel();
    delete window.__ELEVENEX_RUNTIME__;
    vi.useRealTimers();
  });

  it('requires a second action after the same short guard used by delete', () => {
    service.request(11, archive, owner);
    service.confirm(owner);
    vi.advanceTimersByTime(299);
    expect(service.confirmReady()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(service.confirmReady()).toBe(true);
    service.confirm(owner);
    service.confirm(owner);
    expect(archive).toHaveBeenCalledOnce();
    expect(service.isPending('session', 11)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'escape', 'outside', 'timeout'])(
    'leaves running work alone on %s and allows retry',
    (reason) => {
      service.request(11, archive, owner);
      if (reason === 'cancel') service.cancel(owner);
      if (reason === 'escape')
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      if (reason === 'outside')
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      if (reason === 'timeout') vi.advanceTimersByTime(3000);
      expect(archive).not.toHaveBeenCalled();
      expect(service.isPending('session', 11)).toBe(false);
      service.request(11, archive, owner);
      vi.advanceTimersByTime(300);
      service.confirm(owner);
      expect(archive).toHaveBeenCalledOnce();
    },
  );

  it('keeps the decision armed while interacting with its controls', () => {
    const control = document.createElement('button');
    control.setAttribute('data-session-archive-controls', 'true');
    document.body.append(control);
    try {
      service.request(11, archive, owner);
      control.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(service.isPending('session', 11, owner)).toBe(true);
    } finally {
      control.remove();
    }
  });

  it('does not reset the guard or replace the callback on repeated clicks', () => {
    const duplicate = vi.fn();
    service.request(11, archive, owner);
    vi.advanceTimersByTime(200);
    service.request(11, duplicate, owner);
    vi.advanceTimersByTime(100);
    service.confirm(owner);
    expect(archive).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('rejects decisions made against another backend', () => {
    service.request(11, archive, owner);
    vi.advanceTimersByTime(300);
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://second-backend.test' };
    service.confirm(owner);
    expect(archive).not.toHaveBeenCalled();
    expect(service.isPending('session', 11)).toBe(false);
    service.request(11, archive, owner);
    vi.advanceTimersByTime(300);
    service.confirm(owner);
    expect(archive).toHaveBeenCalledOnce();
  });

  it('cleans up on view destruction and ignores requests from destroyed views', () => {
    const fixture = TestBed.createComponent(ArchiveOwner);
    const viewOwner = fixture.componentRef.injector.get(DestroyRef);
    service.request(11, archive, viewOwner);
    fixture.destroy();
    expect(service.isPending('session', 11)).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(service.confirmReady()).toBe(false);
    service.request(11, archive, viewOwner);
    expect(service.isPending('session', 11)).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });

  it('does not let another view confirm or cancel the decision', () => {
    const other = TestBed.createComponent(ArchiveOwner).componentRef.injector.get(DestroyRef);
    service.request(11, archive, owner);
    vi.advanceTimersByTime(300);
    service.confirm(other);
    service.cancel(other);
    expect(archive).not.toHaveBeenCalled();
    expect(service.pendingSessionId(owner)).toBe(11);
    expect(service.pendingSessionId(other)).toBeNull();
  });

  it.each(['idle', 'waiting'] as const)(
    'archives verified %s sessions immediately without background work',
    (activityStatus) => {
      getActivity.mockReturnValue({
        activityStatus,
        backgroundActive: false,
        actionKind: null,
        actionLabel: null,
      });
      service.request(11, archive, owner);
      expect(archive).toHaveBeenCalledOnce();
      expect(service.isPending('session', 11)).toBe(false);
    },
  );

  it.each(['background', 'unknown'])('confirms %s activity', (state) => {
    getActivity.mockReturnValue(
      state === 'unknown'
        ? null
        : {
            activityStatus: 'waiting',
            backgroundActive: true,
            actionKind: null,
            actionLabel: null,
          },
    );
    service.request(11, archive, owner);
    expect(archive).not.toHaveBeenCalled();
    expect(service.isPending('session', 11, owner)).toBe(true);
  });

  it('confirms a folder if any member is working', () => {
    getActivity.mockImplementation((id) => ({
      activityStatus: id === 12 ? 'running' : 'idle',
      backgroundActive: false,
      actionKind: null,
      actionLabel: null,
    }));
    service.requestFolder({ id: 8, sessions: [{ id: 11 }, { id: 12 }] as any }, archive, owner);
    expect(service.isPending('folder', 8, owner)).toBe(true);
    expect(archive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    service.confirm(owner);
    expect(archive).toHaveBeenCalledOnce();
  });

  it('replaces a folder decision when another session is armed', () => {
    const singleArchive = vi.fn();
    service.requestFolder({ id: 8, sessions: [{ id: 11 }] as any }, archive, owner);
    service.request(12, singleArchive, owner);
    expect(service.isPending('folder', 8)).toBe(false);
    vi.advanceTimersByTime(300);
    service.confirm(owner);
    expect(archive).not.toHaveBeenCalled();
    expect(singleArchive).toHaveBeenCalledOnce();
  });
});
