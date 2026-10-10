import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { provideZard } from '@/shared/core/provider/providezard';
import { OpenCodeLoginCardComponent } from './opencode-login-card.component';

describe('OpenCode login', () => {
  it.each(['light', 'dark'])(
    'completes browser OAuth from native status events in %s mode',
    async (theme) => {
      const api = {
        startLogin: vi.fn(() =>
          of({ authUrl: null, message: 'Open browser', mode: 'oauth', supportsManualCode: false }),
        ),
      };
      await TestBed.configureTestingModule({
        imports: [OpenCodeLoginCardComponent],
        providers: [provideZard(), { provide: AgentRuntimeApiService, useValue: api }],
      }).compileComponents();
      const fixture = TestBed.createComponent(OpenCodeLoginCardComponent);
      const status = {
        installed: true,
        authenticated: true,
        isAuthenticating: false,
        output: [],
        providers: [{ id: 'custom', name: 'Custom', connected: true }],
      };
      const wasDark = document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        fixture.componentRef.setInput('status', status);
        fixture.componentInstance.provider.set('custom');
        fixture.detectChanges();
        const authenticated = vi.fn();
        fixture.componentInstance.authenticated.subscribe(authenticated);
        await fixture.componentInstance.login('oauth');
        fixture.detectChanges();
        expect(authenticated).not.toHaveBeenCalled();
        fixture.componentRef.setInput('status', { ...status, isAuthenticating: true });
        fixture.detectChanges();
        fixture.componentRef.setInput('status', status);
        fixture.detectChanges();
        expect(authenticated).toHaveBeenCalledTimes(1);
        expect(fixture.componentInstance.authorization()).toBeNull();
      } finally {
        document.documentElement.classList.toggle('dark', wasDark);
      }
    },
  );
  it('does not complete a cancelled browser login', async () => {
    const status = {
      installed: true,
      authenticated: true,
      isAuthenticating: false,
      output: [],
      providers: [{ id: 'custom', name: 'Custom', connected: true }],
    };
    const api = { cancelLogin: vi.fn(() => of(status)) };
    await TestBed.configureTestingModule({
      imports: [OpenCodeLoginCardComponent],
      providers: [provideZard(), { provide: AgentRuntimeApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(OpenCodeLoginCardComponent);
    fixture.componentInstance.provider.set('custom');
    fixture.componentInstance.authorization.set({
      authUrl: null,
      message: 'Open browser',
      supportsManualCode: false,
    });
    fixture.componentRef.setInput('status', { ...status, isAuthenticating: true });
    fixture.detectChanges();
    const authenticated = vi.fn();
    fixture.componentInstance.authenticated.subscribe(authenticated);
    await fixture.componentInstance.cancel();
    fixture.componentRef.setInput('status', status);
    fixture.detectChanges();
    expect(authenticated).not.toHaveBeenCalled();
  });
  it('discovers provider methods, saves credentials through OpenCode, and clears the key', async () => {
    const api = {
      startLogin: vi.fn(() => of({ authUrl: null, message: 'Saved', mode: 'api_key' })),
    };
    await TestBed.configureTestingModule({
      imports: [OpenCodeLoginCardComponent],
      providers: [provideZard(), { provide: AgentRuntimeApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(OpenCodeLoginCardComponent);
    fixture.componentRef.setInput('status', {
      installed: true,
      authenticated: false,
      providers: [{ id: 'custom', name: 'Custom', connected: false }],
      authMethods: { custom: [{ type: 'api', label: 'API' }] },
    });
    fixture.componentInstance.provider.set('custom');
    fixture.componentInstance.apiKey.set('test-key');
    fixture.detectChanges();
    expect(fixture.componentInstance.supportsApiKey()).toBe(true);
    expect(fixture.componentInstance.supportsOAuth()).toBe(false);
    let authenticated = false;
    fixture.componentInstance.authenticated.subscribe(() => {
      authenticated = true;
    });
    await fixture.componentInstance.login('api_key');
    expect(api.startLogin).toHaveBeenCalledWith(
      { mode: 'api_key', apiKey: 'test-key', apiKeyProvider: 'custom', oauthProvider: 'custom' },
      'opencode',
    );
    expect(fixture.componentInstance.apiKey()).toBe('');
    expect(authenticated).toBe(true);
  });
});
