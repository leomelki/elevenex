import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeService } from '@/shared/services/theme.service';
import { VSCodeWebStateService } from '../vscode-web-state.service';
import { VSCodeWebPanelComponent } from './vscode-web-panel.component';

describe('VSCodeWebPanelComponent startup priority', () => {
  const state = { hasIframe: vi.fn(() => false), hideIframe: vi.fn() };
  beforeEach(async () => {
    state.hasIframe.mockReturnValue(false);
    await TestBed.configureTestingModule({
      imports: [VSCodeWebPanelComponent],
      providers: [
        { provide: VSCodeWebStateService, useValue: state },
        { provide: ThemeService, useValue: { isDark: signal(false) } },
      ],
    }).compileComponents();
  });

  function setup(startupAllowed: boolean) {
    const fixture = TestBed.createComponent(VSCodeWebPanelComponent);
    fixture.componentRef.setInput('sessionId', 7);
    fixture.componentRef.setInput('projectId', 1);
    fixture.componentRef.setInput('worktreePath', '/worktree');
    fixture.componentRef.setInput('startupAllowed', startupAllowed);
    const initialize = vi.spyOn(fixture.componentInstance as any, 'handleSessionChange').mockImplementation(() => undefined);
    const mount = vi.spyOn(fixture.componentInstance as any, 'createOrShowIframe').mockImplementation(() => undefined);
    fixture.detectChanges();
    return { fixture, initialize, mount };
  }

  it('waits for the chat before starting a cold workbench', () => {
    const { fixture, initialize, mount } = setup(false);
    expect(initialize).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    fixture.componentRef.setInput('startupAllowed', true);
    fixture.detectChanges();
    expect(initialize).toHaveBeenCalledWith(7, 1, '/worktree');
  });

  it('shows a cached workbench immediately while the chat loads', () => {
    state.hasIframe.mockReturnValue(true);
    const { initialize, mount } = setup(false);
    expect(initialize).toHaveBeenCalledWith(7, 1, '/worktree');
    expect(mount).toHaveBeenCalledWith(7, 1, '/worktree');
  });

  it('hides the previous workbench while a cold session is loading', () => {
    const { fixture } = setup(true);
    const panel = fixture.componentInstance as any;
    panel.currentSessionId = 7;
    panel.currentIframeKey = 'old-workbench';
    fixture.componentRef.setInput('sessionId', 8);
    fixture.componentRef.setInput('worktreePath', '/new-worktree');
    fixture.componentRef.setInput('startupAllowed', false);
    fixture.detectChanges();
    expect(state.hideIframe).toHaveBeenCalledWith('old-workbench');
    expect(panel.currentIframeKey).toBeNull();
    expect(fixture.componentInstance.isLoading()).toBe(true);
  });
});
