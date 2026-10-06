import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMarkdownComponent } from './agent-markdown.component';

describe('AgentMarkdownComponent video embeds', () => {
  afterEach(() => document.documentElement.classList.remove('dark'));

  it.each(['light', 'dark'])('preserves players in Angular innerHTML in %s mode', async (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    await TestBed.configureTestingModule({ imports: [AgentMarkdownComponent] }).compileComponents();
    const fixture = TestBed.createComponent(AgentMarkdownComponent);
    fixture.componentRef.setInput(
      'content',
      '[Demo](clips/demo.mp4)\n\n<video src="https://cdn.test/demo.webm"></video>',
    );
    fixture.componentRef.setInput('worktreePath', '/tmp/repo');
    const openFile = vi.fn();
    fixture.componentInstance.openLocalFile.subscribe(openFile);
    fixture.detectChanges();
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const videos = Array.from(host.querySelectorAll('video'));
    expect(videos).toHaveLength(2);
    expect(videos[0].getAttribute('aria-label')).toBe('Demo');
    for (const video of videos) {
      expect(video.controls).toBe(true);
      expect(video.autoplay).toBe(false);
      expect(video.classList.contains('cw-video')).toBe(true);
      video.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    expect(openFile).not.toHaveBeenCalled();

    fixture.componentRef.setInput('content', 'Next response');
    fixture.detectChanges();
    expect(host.querySelector('video')).toBeNull();
  });
});
