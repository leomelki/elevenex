import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';
import { buildElevenexToolView } from '@/shared/agent-tools/elevenex-tool-view';
import { ElevenexToolResultComponent } from './elevenex-tool-result.component';

afterEach(() => {
  TestBed.resetTestingModule();
  document.documentElement.classList.remove('dark');
});
describe('Elevenex tool result UI', () => {
  it.each(['light', 'dark'])(
    'renders port routes, failures, attribution and working Ports navigation in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      await TestBed.configureTestingModule({
        imports: [ElevenexToolResultComponent],
        providers: [provideRouter([])],
      }).compileComponents();
      const fixture = TestBed.createComponent(ElevenexToolResultComponent);
      fixture.componentRef.setInput(
        'view',
        buildElevenexToolView(
          { toolName: 'mcp__elevenex__create_port_forward', toolInput: { remotePort: 5173 } },
          {
            content: {
              data: {
                projectId: 5,
                forwards: [
                  {
                    id: 12,
                    name: 'Preview',
                    bindAddress: '127.0.0.1',
                    localPort: 5174,
                    remoteHost: 'localhost',
                    remotePort: 5173,
                    connectionLabel: 'Dev server',
                    status: 'error',
                    running: false,
                    lastError: 'Local port is occupied',
                    localUrl: 'http://127.0.0.1:5174',
                    createdBySession: { sessionId: 42, sessionName: 'Preview agent' },
                  },
                ],
              },
              deepLink: '/projects/5#ssh-forwarding',
            },
          },
        ),
      );
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-port-forwarding-result]')).not.toBeNull();
      expect(el.textContent).toContain('127.0.0.1:5174');
      expect(el.textContent).toContain('localhost:5173');
      expect(el.textContent).toContain('Could not start');
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Local port is occupied');
      expect(el.querySelector('a[href="/projects/5#ssh-forwarding"]')?.textContent).toContain(
        'Open Ports',
      );
      expect(el.querySelector('a[href="/sessions/42"]')?.textContent).toContain('Preview agent');
      expect(el.querySelector('a[href^="http:"]')).toBeNull();
      expect(
        el.querySelector('button[aria-label="Copy desktop address for Preview"]'),
      ).not.toBeNull();
      fixture.destroy();
    },
  );
  it.each(['light', 'dark'])(
    'renders task identities, semantic states and expandable details in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      await TestBed.configureTestingModule({
        imports: [ElevenexToolResultComponent],
        providers: [provideRouter([])],
      }).compileComponents();
      const fixture = TestBed.createComponent(ElevenexToolResultComponent);
      const call = { toolName: 'mcp__elevenex__get_task', toolInput: { taskId: 9 } };
      const content = {
        data: {
          taskId: 9,
          name: 'Fix auth',
          state: 'ready',
          branch: 'fix/auth',
          environmentPath: '/checkout',
          sessions: [{ sessionId: 42, name: 'Review', status: 'created' }],
        },
        deepLink: '/tasks/9',
      };
      fixture.componentRef.setInput('view', buildElevenexToolView(call, { content }));
      fixture.componentRef.setInput('toolInput', call.toolInput);
      const captured = {
        structuredContent: content,
        content: [{ type: 'text', text: 'Provider metadata' }],
      };
      fixture.componentRef.setInput('toolOutput', captured);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.textContent).toContain('Fix auth');
      expect(el.textContent).toContain('Not started');
      expect(el.querySelector('a[href="/tasks/9"]')).not.toBeNull();
      expect(el.querySelector('a[href="/sessions/42"]')).not.toBeNull();
      expect(el.textContent).not.toContain('"taskId"');
      fixture.componentInstance.toggleDetails();
      fixture.detectChanges();
      expect(el.textContent).toContain('"taskId": 9');
      expect(el.textContent).toContain('Copy details');
      expect(JSON.parse(fixture.componentInstance.raw()).response).toEqual(captured);
      fixture.destroy();
    },
  );
  it('shows errors and recovery links without rendering unsafe navigation', async () => {
    await TestBed.configureTestingModule({
      imports: [ElevenexToolResultComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ElevenexToolResultComponent);
    const content = {
      error: {
        code: 'branch_in_use',
        message: 'Already in use',
        details: { existingTaskId: 9, canSnapshot: true },
      },
      deepLink: 'javascript:alert(1)',
    };
    fixture.componentRef.setInput(
      'view',
      buildElevenexToolView({ toolName: 'mcp__elevenex__create_task' }, { content, isError: true }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'independent snapshot',
    );
    expect(fixture.nativeElement.querySelector('a[href="/tasks/9"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('a[href^="javascript:"]')).toBeNull();
    fixture.destroy();
  });
});
