import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ClaudeStatusBarComponent } from './claude-status-bar.component';

describe('ClaudeStatusBarComponent', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [ClaudeStatusBarComponent],
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
    fixture.componentInstance.planModeChange.subscribe((value) =>
      planChanges.push(value),
    );
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

    expect(fixture.componentInstance.activePermissionLabel()).toBe('Accept edits');
    expect(fixture.nativeElement.textContent).toContain('Plan on');
  });
});
