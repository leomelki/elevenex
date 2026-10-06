import '@angular/compiler';
import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { provideZard } from '@/shared/core/provider/providezard';
import { describe, expect, it } from 'vitest';
import { ClaudeStatusBarComponent } from './claude-status-bar.component';

describe('ClaudeStatusBarComponent', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [ClaudeStatusBarComponent],
      providers: [provideZard()],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeStatusBarComponent);
    fixture.componentRef.setInput('providers', [
      {
        id: 'claude',
        displayName: 'Claude Code',
        capabilities: {
          mcp: true,
          subagents: true,
          permissions: true,
          userInput: true,
          multimodalPrompts: true,
          terminalFallback: true,
          rewindConversation: true,
        },
      },
      {
        id: 'codex',
        displayName: 'OpenAI Codex',
        capabilities: {
          mcp: true,
          subagents: false,
          permissions: true,
          userInput: true,
          multimodalPrompts: true,
          terminalFallback: false,
          rewindConversation: false,
        },
      },
    ]);
    return fixture;
  }

  it('offers auto mode for Codex permission controls without plan styles', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('currentProvider', 'codex');
    fixture.detectChanges();

    expect(fixture.componentInstance.permissionOptions().map((option) => option.id)).toEqual([
      'auto',
      'default',
      'acceptEdits',
      'bypassPermissions',
    ]);
  });

  it('toggles plan mode with Shift+Tab instead of cycling permission style', async () => {
    const fixture = await render();
    const permissionChanges: unknown[] = [];
    const planChanges: unknown[] = [];
    fixture.componentInstance.permissionModeChange.subscribe((value) =>
      permissionChanges.push(value),
    );
    fixture.componentInstance.planModeChange.subscribe((value) => planChanges.push(value));
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));

    expect(permissionChanges).toEqual([]);
    expect(planChanges).toEqual([true]);
  });

  it('keeps permission style stable while plan mode is enabled', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('permissionMode', 'acceptEdits');
    fixture.componentRef.setInput('planMode', true);
    fixture.detectChanges();

    expect(fixture.componentInstance.activePermissionLabel()).toBe('Allow file edits');
    expect(fixture.nativeElement.querySelector('.cw-sb__plan').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows provider-reported plan usage with a detailed allowance popover', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('currentProvider', 'codex');
    fixture.componentRef.setInput('planUsage', {
      provider: 'codex',
      planName: 'Plus',
      status: 'warning',
      windows: [
        {
          id: 'primary',
          label: '5-hour limit',
          remainingPercentage: 18,
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
        },
        {
          id: 'secondary',
          label: 'Weekly limit',
          remainingPercentage: 64,
          resetsAt: null,
        },
      ],
      credits: null,
      updatedAt: new Date().toISOString(),
    });
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('.cw-sb__usage-trigger') as HTMLElement;
    expect(trigger.textContent).toContain('18% plan left');
    trigger.click();
    fixture.detectChanges();

    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    expect(overlay.textContent).toContain('Codex usage');
    expect(overlay.textContent).toContain('5-hour limit');
    expect(overlay.textContent).toContain('Weekly limit');
    expect(overlay.textContent).toContain('Plus');
  });

  it('navigates model choices with the keyboard, selects once and restores trigger focus', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('providerLocked', true);
    fixture.componentRef.setInput('availableModels', [
      { id: 'model-a', displayName: 'Model A', description: 'A model' },
    ]);
    const selected: string[] = [];
    fixture.componentInstance.modelChange.subscribe((model) => selected.push(model));
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Configure agent, model and thinking"]',
    ) as HTMLButtonElement;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(
      TestBed.inject(OverlayContainer).getContainerElement().querySelector('[role="menu"]'),
    ).toBeNull();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const menu = overlay.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('aria-label')).toBe('Agent, model and thinking');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('Agent default');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('Model A');
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(selected).toEqual(['model-a']);
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes menus on Escape and disposes an open menu when the status bar is destroyed', async () => {
    const fixture = await render();
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Configure agent, model and thinking"]',
    ) as HTMLButtonElement;
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    trigger.click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menu = overlay.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    fixture.detectChanges();
    expect(overlay.querySelector('[role="menu"]')).not.toBeNull();
    fixture.destroy();
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
  });

  it('changes the agent from the model menu and restores focus after selection', async () => {
    const fixture = await render();
    const changes: string[] = [];
    fixture.componentInstance.providerChange.subscribe((provider) => changes.push(provider));
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector(
      '.cw-sb__model-trigger',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const agentTrigger = overlay.querySelector('[aria-label="Change agent"]') as HTMLButtonElement;
    agentTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const options = overlay.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Agent"] [role="menuitemradio"]',
    );
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(options[0]);
    options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(options[1]);
    options[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(changes).toEqual(['codex']);
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('explains the locked agent in the model menu while keeping models editable', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('providerLocked', true);
    fixture.componentRef.setInput('availableModels', [
      { id: 'model-a', displayName: 'Model A', description: '' },
    ]);
    const changes: string[] = [];
    fixture.componentInstance.providerChange.subscribe((provider) => changes.push(provider));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.cw-sb__model-trigger').click();
    fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    expect(overlay.querySelector('[aria-label="Change agent"]')).toBeNull();
    expect(overlay.querySelector('.cw-sb__agent-header')?.textContent).toContain('Claude Code');
    expect(
      overlay.querySelector('[aria-label="Agent cannot be changed after the conversation starts"]'),
    ).not.toBeNull();
    expect(overlay.querySelectorAll('[aria-label="Model"] [role="menuitemradio"]')).toHaveLength(2);
    fixture.componentInstance.pickProvider('codex');
    expect(changes).toEqual([]);
  });

  it('keeps agent selection out of the settings panel', async () => {
    const fixture = await render();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Agent settings"]').click();
    fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    expect(overlay.querySelector('input[value="claude"]')).toBeNull();
    expect(overlay.querySelector('input[value="codex"]')).toBeNull();
    expect(overlay.querySelector('[aria-label="Change agent"]')).toBeNull();
  });

  it('keeps permissions editable while the agent is locked', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('providerLocked', true);
    const permissionChanges: string[] = [];
    const providerChanges: string[] = [];
    fixture.componentInstance.permissionModeChange.subscribe((mode) =>
      permissionChanges.push(mode),
    );
    fixture.componentInstance.providerChange.subscribe((provider) =>
      providerChanges.push(provider),
    );
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Agent settings"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    expect(overlay.querySelector('input[value="codex"]')).toBeNull();
    expect(overlay.querySelector('input[value="claude"]')).toBeNull();
    expect(providerChanges).toEqual([]);
    const permission = overlay.querySelector('input[value="acceptEdits"]') as HTMLInputElement;
    expect(permission.matches(':disabled')).toBe(false);
    permission.click();
    fixture.detectChanges();
    expect(permissionChanges).toEqual(['acceptEdits']);
    expect(permission.checked).toBe(false);
    fixture.componentRef.setInput('permissionMode', 'acceptEdits');
    fixture.detectChanges();
    expect(permission.checked).toBe(true);
    permission.click();
    expect(permissionChanges).toEqual(['acceptEdits']);
    expect(overlay.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('changes working mode only when selecting the other segment', async () => {
    const fixture = await render();
    const changes: boolean[] = [];
    fixture.componentInstance.planModeChange.subscribe((mode) => changes.push(mode));
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll(
      '.cw-sb__work-mode button',
    ) as NodeListOf<HTMLButtonElement>;
    buttons[0].click();
    expect(changes).toEqual([]);
    buttons[1].click();
    expect(changes).toEqual([true]);
    fixture.componentRef.setInput('planMode', true);
    fixture.detectChanges();
    buttons[1].click();
    expect(changes).toEqual([true]);
    buttons[0].click();
    expect(changes).toEqual([true, false]);
  });

  it.each([
    ['Connected tools', 'openMcp'],
    ['Raw terminal', 'openTerminal'],
    ['Export conversation…', 'export'],
  ] as const)('opens %s from settings and dismisses the panel', async (label, event) => {
    const fixture = await render();
    const changes: void[] = [];
    fixture.componentInstance[event].subscribe((value) => changes.push(value));
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Agent settings"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const action = [
      ...overlay.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="Conversation actions"] button',
      ),
    ].find((button) => button.textContent?.includes(label));
    expect(action).toBeDefined();
    action!.click();
    fixture.detectChanges();

    expect(changes).toHaveLength(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows conversation tools only when the agent supports them', async () => {
    const fixture = await render();
    fixture.componentRef.setInput(
      'providers',
      fixture.componentInstance.providers().map((provider) => ({
        ...provider,
        capabilities: { ...provider.capabilities, mcp: false, terminalFallback: false },
      })),
    );
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Agent settings"]').click();
    fixture.detectChanges();

    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const actions = overlay.querySelector('[aria-label="Conversation actions"]')!;
    expect(actions.textContent).toContain('Export conversation');
    expect(actions.textContent).not.toContain('Connected tools');
    expect(actions.textContent).not.toContain('Raw terminal');
  });

  it('offers only model-supported reasoning levels and shows the chosen level', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('selectedModel', 'model-a');
    fixture.componentRef.setInput('availableModels', [
      {
        id: 'model-a',
        displayName: 'Model A',
        description: '',
        supportsEffort: true,
        reasoningEfforts: ['low', 'high'],
      },
    ]);
    fixture.componentRef.setInput('reasoningEffort', 'high');
    const changes: unknown[] = [];
    fixture.componentInstance.reasoningEffortChange.subscribe((effort) => changes.push(effort));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cw-sb__model-trigger').textContent).toContain(
      'Model A',
    );
    const trigger = fixture.nativeElement.querySelector(
      '.cw-sb__model-trigger',
    ) as HTMLButtonElement;
    expect(trigger.textContent).toContain('High');
    trigger.click();
    fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const options = overlay.querySelectorAll<HTMLButtonElement>(
      '[role="group"][aria-label="Thinking"] [role="menuitemradio"]',
    );
    expect(options).toHaveLength(3);
    expect(options[2].getAttribute('aria-checked')).toBe('true');
    options[1].click();
    expect(changes).toEqual(['low']);
  });

  it('shows the reported default model instead of guessing from catalog order', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('availableModels', [
      { id: 'model-a', displayName: 'Model A', description: '' },
      { id: 'model-b', displayName: 'Model B', description: '', isProviderDefault: true },
    ]);
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedModelLabel()).toBe('Model B');
    fixture.componentRef.setInput('availableModels', [
      { id: 'model-a', displayName: 'Model A', description: '' },
    ]);
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedModelLabel()).toBe('Agent default');
  });

  it.each(['light', 'dark'])(
    'keeps thinking editable after Claude resolves its model ID in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        const fixture = await render();
        fixture.componentRef.setInput('providerLocked', true);
        fixture.componentRef.setInput('phase', 'running');
        fixture.componentRef.setInput('availableModels', [
          {
            id: 'sonnet',
            displayName: 'Sonnet',
            description: '',
            supportsEffort: true,
            reasoningEfforts: ['low', 'medium', 'high'],
            supportsAutoMode: true,
          },
          { id: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
        ]);
        fixture.componentRef.setInput('selectedModel', 'claude-sonnet-4-6');
        fixture.componentRef.setInput('reasoningEffort', 'high');
        const changes: unknown[] = [];
        fixture.componentInstance.reasoningEffortChange.subscribe((effort) => changes.push(effort));
        fixture.detectChanges();

        const trigger = fixture.nativeElement.querySelector(
          '.cw-sb__model-trigger',
        ) as HTMLButtonElement;
        expect(trigger.textContent).toContain('Sonnet');
        expect(trigger.textContent).toContain('High');
        expect(
          fixture.componentInstance.permissionOptions().some((option) => option.id === 'auto'),
        ).toBe(true);
        trigger.click();
        fixture.detectChanges();
        const overlay = TestBed.inject(OverlayContainer).getContainerElement();
        const modelOptions = overlay.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Model"] [role="menuitemradio"]',
        );
        expect(modelOptions[1].getAttribute('aria-checked')).toBe('true');
        const options = overlay.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Thinking"] [role="menuitemradio"]',
        );
        expect(options).toHaveLength(4);
        expect(options[3].getAttribute('aria-checked')).toBe('true');
        options[1].click();
        expect(changes).toEqual(['low']);

        fixture.componentRef.setInput('reasoningEffort', 'low');
        fixture.detectChanges();
        expect(trigger.textContent).toContain('Low');
        fixture.componentRef.setInput('selectedModel', 'claude-haiku-4-5-20251001');
        fixture.detectChanges();
        expect(fixture.componentInstance.selectedModelSupportsEffort()).toBe(false);
        fixture.componentRef.setInput('currentProvider', 'codex');
        fixture.componentRef.setInput('selectedModel', 'claude-sonnet-4-6');
        fixture.detectChanges();
        expect(fixture.componentInstance.selectedModelOption()).toBeUndefined();
      } finally {
        document.documentElement.classList.remove('dark');
      }
    },
  );

  it('uses exact Claude model capabilities before falling back to a family alias', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('availableModels', [
      { id: 'sonnet', displayName: 'Sonnet', description: '', supportsEffort: true },
      { id: 'claude-sonnet-4-0', displayName: 'Sonnet 4', description: '', supportsEffort: false },
    ]);
    fixture.componentRef.setInput('selectedModel', 'claude-sonnet-4-0');
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedModelLabel()).toBe('Sonnet 4');
    expect(fixture.componentInstance.selectedModelSupportsEffort()).toBe(false);
  });

  it('leaves a menu with Shift+Tab without toggling plan mode', async () => {
    const fixture = await render();
    const planChanges: boolean[] = [];
    fixture.componentInstance.planModeChange.subscribe((value) => planChanges.push(value));
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector(
      '[aria-label="Configure agent, model and thinking"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const menu = overlay.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    fixture.detectChanges();

    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(planChanges).toEqual([]);
  });

  it('does not reserve status-bar space when plan usage is unavailable', async () => {
    const fixture = await render();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-sb__usage-trigger')).toBeNull();
  });
});
