import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import '@angular/compiler';
import { Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeTranscriptComponent } from './claude-transcript.component';
import { pairTranscript } from './paired-transcript';
import { buildTranscriptRenderItems } from './transcript-render-items';
import { TranscriptViewportDirective } from './transcript-viewport.directive';

@Component({
  imports: [TranscriptViewportDirective, ClaudeTranscriptComponent],
  template:
    '<div cwTranscriptViewport [items]="items()"><cw-transcript [items]="renderItems()" /></div>',
})
class TestHost {
  readonly items = signal<AgentTranscriptItem[]>([]);
  readonly renderItems = computed(() =>
    buildTranscriptRenderItems({
      units: pairTranscript(this.items()),
      settled: false,
      childItemsByParentToolUseId: {},
      subagents: [],
      hookEvents: [],
    }),
  );
}

const item = (id: string, content: string): AgentTranscriptItem => ({
  id,
  content,
  kind: 'user',
  timestamp: '',
});
const image = '[Image: original 1100x3000, displayed at 733x2000.]';

describe('TranscriptViewportDirective prompt navigation', () => {
  it('uses human prompts for the index and floating context, preserving quoted examples', async () => {
    await TestBed.configureTestingModule({ imports: [TestHost] }).compileComponents();
    const fixture = TestBed.createComponent(TestHost);
    fixture.componentInstance.items.set([
      item('human', `Check this\n${image}`),
      item('skill', 'Base directory for this skill: /repo/write-tests\nInstructions'),
      item('image', image),
      item(
        'task',
        '<task-notification><task-id>1</task-id><summary>Done</summary></task-notification>',
      ),
      item('empty', ' \n\t'),
      item('quoted', `\`\`\`text\n${image}\n\`\`\``),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    const debug = fixture.debugElement.query(By.directive(TranscriptViewportDirective));
    const viewport = debug.injector.get(TranscriptViewportDirective);
    expect([...viewport.userPromptIndex().byId.keys()]).toEqual(['human', 'quoted']);
    expect(viewport.userPromptIndex()).toMatchObject({ firstId: 'human', lastId: 'quoted' });
    const container = debug.nativeElement as HTMLElement;
    const prompts = container.querySelectorAll<HTMLElement>('[data-user-prompt-id]');
    expect(prompts).toHaveLength(2);
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(prompts[0], 'getBoundingClientRect').mockReturnValue({
      top: -150,
      bottom: -50,
    } as DOMRect);
    vi.spyOn(prompts[1], 'getBoundingClientRect').mockReturnValue({
      top: 200,
      bottom: 300,
    } as DOMRect);
    viewport.onTranscriptScroll();
    expect(viewport.contextualPrompt()?.id).toBe('human');
    expect(viewport.contextualPromptText()).toBe('Check this');

    fixture.componentInstance.items.set([item('empty', '')]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(viewport.userPromptIndex().byId.size).toBe(0);
    expect(viewport.contextualPrompt()).toBeNull();
  });
});
