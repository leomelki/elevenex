import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { OverlayContainer } from '@angular/cdk/overlay';
import { of, Subject } from 'rxjs';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { McpManagerStore } from '../mcp-manager.store';
import { ClaudeMcpDrawerComponent } from './claude-mcp-drawer.component';
import type { AgentMcpSnapshot } from '@/shared/models/agent-runtime.model';

describe('MCP overlay', () => {
  it('updates its portaled list after the asynchronous snapshot arrives', async () => {
    const response = new Subject<AgentMcpSnapshot>();
    TestBed.configureTestingModule({
      imports: [ClaudeMcpDrawerComponent],
      providers: [
        McpManagerStore,
        { provide: ClaudeRuntimeApiService, useValue: { getMcpSnapshot: () => response } },
      ],
    });
    const store = TestBed.inject(McpManagerStore);
    TestBed.runInInjectionContext(() => store.bind(signal(1), signal('pi')));
    const fixture = TestBed.createComponent(ClaudeMcpDrawerComponent);
    fixture.componentRef.setInput('store', store);
    fixture.detectChanges();
    store.show();
    fixture.detectChanges();
    const container = TestBed.inject(OverlayContainer).getContainerElement();
    expect(container.querySelector('[data-mcp-manager]')).not.toBeNull();
    response.next({
      servers: [
        {
          entryId: 'id',
          name: 'docs',
          scope: 'project',
          transport: 'http',
          configLocation: '/tmp/mcp.json',
          enabled: true,
          connectionStatus: 'connected',
          configStatus: 'valid',
          actions: {
            canToggle: false,
            canRecheck: false,
            canAuth: false,
            canReauth: false,
            canViewTools: false,
          },
        },
      ],
      diagnostics: [],
      summary: { total: 1, connected: 1, disabled: 0, failed: 0, malformed: 0, needsAuth: 0 },
      lastUpdatedAt: '',
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(container.querySelector('[data-mcp-server="docs"]')).not.toBeNull();
    expect(container.textContent).toContain('Connected');
  });
});
