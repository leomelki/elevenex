import { TestBed } from '@angular/core/testing';
import { OverlayContainer } from '@angular/cdk/overlay';
import { provideZard } from '@/shared/core/provider/providezard';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeAgentInspectorComponent } from './claude-agent-inspector.component';
import { buildSessionAgentSummary } from './agent-deep-dive';
import type { AgentSubagentState } from '@/shared/models/agent-runtime.model';

const usage = {
  model: 'child-model',
  totalTokens: 100_000,
  maxTokens: 200_000,
  percentage: 47,
  inputTokens: 90_000,
  outputTokens: 10_000,
  cacheReadInputTokens: 80_000,
  cacheCreationInputTokens: 0,
  memoryFiles: [],
  mcpTools: [],
};

const timestamp = '2026-10-12T10:00:00.000Z';
const agents: AgentSubagentState[] = [
  {
    agentId: 'child',
    agentType: 'explorer',
    displayName: 'Ada',
    status: 'started',
    executionStatus: 'running',
    prompt: 'Inspect tests',
    timestamp,
  },
  {
    agentId: 'nested',
    agentType: 'worker',
    displayName: 'Grace',
    parentAgentId: 'child',
    status: 'stopped',
    executionStatus: 'error',
    timestamp,
  },
];
async function setup() {
  await TestBed.configureTestingModule({
    imports: [ClaudeAgentInspectorComponent],
    providers: [provideZard()],
  }).compileComponents();
  const fixture = TestBed.createComponent(ClaudeAgentInspectorComponent);
  fixture.componentRef.setInput('open', true);
  fixture.componentRef.setInput('turn', buildSessionAgentSummary(agents));
  fixture.componentRef.setInput('selectedAgentId', 'child');
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}
describe('ClaudeAgentInspectorComponent', () => {
  it('defaults to shared chat, collapses completed work, and expands thinking and tools with the normal controls', async () => {
    const fixture = await setup();
    const child = {
      ...agents[0],
      status: 'stopped' as const,
      executionStatus: 'completed' as const,
    };
    fixture.componentRef.setInput('turn', buildSessionAgentSummary([child]));
    fixture.componentRef.setInput('historyByAgent', {
      child: {
        loading: false,
        error: null,
        data: {
          subagent: child,
          transcriptAvailable: true,
          history: [
            { id: 'prompt', kind: 'user', content: 'Inspect tests', timestamp },
            { id: 'thought', kind: 'thinking', content: 'Check relevant tests first.', timestamp },
            {
              id: 'call',
              kind: 'tool_use',
              toolName: 'Bash',
              toolUseId: 'command',
              toolInput: { command: 'rg --files' },
              timestamp,
            },
            {
              id: 'result',
              kind: 'tool_result',
              toolUseId: 'command',
              content: 'tests.spec.ts',
              timestamp,
            },
            {
              id: 'answer',
              kind: 'assistant',
              content: 'Found relevant tests.',
              timestamp: '2026-10-12T10:01:00.000Z',
            },
          ],
        },
      },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.tab()).toBe('transcript');
    expect(fixture.nativeElement.querySelector('cw-transcript')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('cw-message')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('cw-tool-call')).toBeNull();
    const summary = fixture.nativeElement.querySelector(
      'cw-turn-summary button',
    ) as HTMLButtonElement;
    summary.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('cw-thinking')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('cw-tool-call')).toBeTruthy();
    fixture.componentInstance.tab.set('timeline');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cw-agent-dive__timeline')).toBeTruthy();
  });
  it.each(['light', 'dark'])(
    'keeps context in the normal compact status button with details on demand in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        const fixture = await setup();
        fixture.componentRef.setInput(
          'turn',
          buildSessionAgentSummary([
            { ...agents[0], contextUsage: usage, contextUsageUpdatedAt: timestamp },
            agents[1],
          ]),
        );
        fixture.detectChanges();
        await fixture.whenStable();
        const button = fixture.nativeElement.querySelector(
          'cw-context-usage button',
        ) as HTMLButtonElement;
        expect(button.textContent).toContain('Context 47%');
        expect(button.getAttribute('aria-label')).toContain('Ada context: 47% used');
        expect(
          fixture.nativeElement.querySelector('.cw-agent-dive__rail').textContent,
        ).not.toContain('Context');
        const overlay = TestBed.inject(OverlayContainer).getContainerElement();
        expect(overlay.querySelector('[aria-label="Context usage details"]')).toBeNull();
        button.click();
        fixture.detectChanges();
        await fixture.whenStable();
        const detail = overlay.querySelector('[aria-label="Context usage details"]')!;
        expect(detail.textContent).toContain('100,000');
        expect(detail.textContent).toContain('200,000');
        expect(detail.textContent).toContain('Last reported');
        fixture.componentRef.setInput('selectedAgentId', 'nested');
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('cw-context-usage')).toBeNull();
        expect(fixture.nativeElement.textContent).not.toContain('Context usage unavailable');
        fixture.destroy();
      } finally {
        document.documentElement.classList.remove('dark');
      }
    },
  );
  it('merges context by its own revision and preserves a newer live count over cached transcript usage', async () => {
    const fixture = await setup();
    const newer = '2026-10-12T10:03:00.000Z';
    const cached = {
      ...agents[0],
      contextUsage: usage,
      contextUsageUpdatedAt: '2026-10-12T10:02:00.000Z',
    };
    fixture.componentRef.setInput('historyByAgent', {
      child: {
        loading: false,
        error: null,
        data: { subagent: cached, history: [], transcriptAvailable: true },
      },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedAgent()?.contextUsage?.percentage).toBe(47);
    fixture.componentRef.setInput(
      'turn',
      buildSessionAgentSummary([
        {
          ...agents[0],
          contextUsage: { ...usage, totalTokens: 20_000, percentage: 4 },
          contextUsageUpdatedAt: newer,
        },
      ]),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedAgent()?.contextUsage?.percentage).toBe(4);
    fixture.componentRef.setInput('historyByAgent', {
      child: {
        loading: false,
        error: null,
        data: {
          subagent: {
            ...cached,
            contextUsage: null,
            contextUsageUpdatedAt: '2026-10-12T10:04:00.000Z',
          },
          history: [],
          transcriptAvailable: true,
        },
      },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedAgent()?.contextUsage).toBeNull();
  });
  it('orders nested agents below their parent and supports search and attention filters', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance;
    expect(component.visibleAgents().map(({ agent, depth }) => [agent.displayName, depth])).toEqual(
      [
        ['Ada', 0],
        ['Grace', 1],
      ],
    );
    component.filter.set('attention');
    expect(component.visibleAgents().map(({ agent }) => agent.agentId)).toEqual(['nested']);
    component.filter.set('all');
    component.search.set('tests');
    expect(component.visibleAgents().map(({ agent }) => agent.agentId)).toEqual(['child']);
    expect(fixture.nativeElement.querySelector('[role=dialog]').getAttribute('aria-modal')).toBe(
      'true',
    );
    expect(fixture.nativeElement.textContent).not.toContain('Hooks');
  });
  it('shows a retry action for transcript failures while retaining the assignment', async () => {
    const fixture = await setup();
    const refresh = vi.fn();
    fixture.componentInstance.refreshAgent.subscribe(refresh);
    fixture.componentRef.setInput('historyByAgent', {
      child: { loading: false, data: null, error: 'Transcript unavailable' },
    });
    fixture.detectChanges();
    const retry = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.trim() === 'Retry');
    retry!.click();
    expect(refresh).toHaveBeenCalledExactlyOnceWith('child');
    expect(fixture.nativeElement.textContent).toContain('Inspect tests');
  });
  it('does not let a cached completion override a new live follow-up', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput(
      'turn',
      buildSessionAgentSummary([{ ...agents[0], timestamp: '2026-10-12T10:01:00.000Z' }]),
    );
    fixture.componentRef.setInput('historyByAgent', {
      child: {
        loading: false,
        error: null,
        data: {
          subagent: { ...agents[0], status: 'stopped', executionStatus: 'completed' },
          history: [],
          transcriptAvailable: true,
        },
      },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedAgent()?.executionStatus).toBe('running');
  });
  it('refreshes only the selected active agent and cancels polling when closed', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await setup();
      const refresh = vi.fn();
      fixture.componentInstance.refreshAgent.subscribe(refresh);
      vi.advanceTimersByTime(2000);
      expect(refresh).toHaveBeenCalledExactlyOnceWith('child');
      fixture.componentRef.setInput('open', false);
      fixture.detectChanges();
      vi.advanceTimersByTime(4000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
