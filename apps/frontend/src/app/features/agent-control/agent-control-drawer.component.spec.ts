import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, beforeEach, afterEach, expect, it } from 'vitest';
import { AgentControlDrawerComponent } from './agent-control-drawer.component';
import { AgentControlStateService } from './agent-control-state.service';

const OVERVIEW = {
  workspace: {
    projectId: 1,
    repoId: 2,
    path: '/home/dev/.elevenex/agent',
    branch: 'main',
  },
  sessions: [],
};

describe('AgentControlDrawerComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AgentControlDrawerComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('loads the workspace and renders the empty state when opened', () => {
    const service = TestBed.inject(AgentControlStateService);
    service.openGlobal();

    const fixture = TestBed.createComponent(AgentControlDrawerComponent);
    fixture.detectChanges();

    const request = httpMock.expectOne('/api/agent');
    expect(request.request.method).toBe('GET');
    request.flush(OVERVIEW);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Elevenex agent');
    expect(text).toContain('No agent sessions yet.');
    expect(text).toContain('/home/dev/.elevenex/agent');
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.agent-control-drawer')
        ?.getAttribute('role'),
    ).toBe('complementary');
  });

  it('creates an agent session from the composer', () => {
    const service = TestBed.inject(AgentControlStateService);
    service.openGlobal();

    const fixture = TestBed.createComponent(AgentControlDrawerComponent);
    fixture.detectChanges();
    httpMock.expectOne('/api/agent').flush(OVERVIEW);
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector(
      'input',
    ) as HTMLInputElement;
    input.value = 'Triage open PRs';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    const submit = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((button) =>
      button.textContent?.includes('New session'),
    ) as HTMLButtonElement;
    submit.click();
    fixture.detectChanges();

    const request = httpMock.expectOne('/api/agent/sessions');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Triage open PRs' });

    request.flush({
      id: 42,
      repoId: 2,
      projectId: 1,
      branchName: 'main',
      worktreePath: '/home/dev/.elevenex/agent',
      name: 'Triage open PRs',
      status: 'created',
      activeAgentProvider: 'claude',
      claudeSessionId: '-1',
      codexSessionId: '-1',
      hasInjectedWorktreeContext: false,
      hasUnreviewedCompletion: false,
      lastCompletionAt: null,
      lastCompletionKind: null,
      lastStateChangeAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Opening the new session closes the drawer.
    expect(service.isOpen()).toBe(false);
  });
});
