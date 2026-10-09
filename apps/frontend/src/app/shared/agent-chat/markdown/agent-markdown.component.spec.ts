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

describe('AgentMarkdownComponent image freshness', () => {
  it.each(['/tmp/repo/shot.png', '/tmp/shot.png'])(
    'reloads new mentions of %s while keeping streaming URLs stable',
    async (path) => {
      await TestBed.configureTestingModule({
        imports: [AgentMarkdownComponent],
      }).compileComponents();
      const first = TestBed.createComponent(AgentMarkdownComponent);
      const second = TestBed.createComponent(AgentMarkdownComponent);
      for (const fixture of [first, second]) {
        fixture.componentRef.setInput('content', `![Shot](${path})`);
        fixture.componentRef.setInput('worktreePath', '/tmp/repo');
        fixture.detectChanges();
      }
      const src = first.nativeElement.querySelector('img').src;
      expect(new URL(src).searchParams.has('_media')).toBe(true);
      expect(second.nativeElement.querySelector('img').src).not.toBe(src);
      first.componentRef.setInput('content', `![Shot](${path})\nMore streamed text`);
      first.detectChanges();
      expect(first.nativeElement.querySelector('img').src).toBe(src);
      first.nativeElement.querySelector('img').click();
      await first.whenStable();
      const viewer = document.querySelector('agent-media-viewer')!;
      expect(viewer.querySelector('img')!.src).not.toBe(src);
      first.destroy();
      second.destroy();
      await new Promise((resolve) => setTimeout(resolve, 180));
    },
  );
});

describe('AgentMarkdownComponent image preview', () => {
  it.each(['light', 'dark'])(
    'opens a gallery with keyboard navigation and zoom in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      await TestBed.configureTestingModule({
        imports: [AgentMarkdownComponent],
      }).compileComponents();
      const fixture = TestBed.createComponent(AgentMarkdownComponent);
      fixture.componentRef.setInput(
        'content',
        '![First](/tmp/first.png)\n\n![Second](/tmp/second.png)\n\n![Third](/tmp/second.png)',
      );
      fixture.componentRef.setInput('worktreePath', '/tmp/repo');
      fixture.detectChanges();
      const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
      expect(image.tabIndex).toBe(0);
      image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await fixture.whenStable();
      const viewer = document.querySelector('agent-media-viewer')!;
      expect(viewer).not.toBeNull();
      expect(viewer.textContent).toContain('First');
      const preview = viewer.querySelector('img')!;
      preview.dispatchEvent(new Event('load'));
      await fixture.whenStable();
      expect(viewer.textContent).toContain('0 × 0');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      await fixture.whenStable();
      expect(viewer.textContent).toContain('100%');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await fixture.whenStable();
      expect(viewer.textContent).toContain('Second');
      expect(viewer.textContent).toContain('2 / 3');
      const secondImage = viewer.querySelector('img');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await fixture.whenStable();
      expect(viewer.textContent).toContain('Third');
      expect(viewer.querySelector('img')).not.toBe(secondImage);
      viewer.querySelector('img')!.dispatchEvent(new Event('error'));
      await fixture.whenStable();
      expect(viewer.textContent).toContain('Image unavailable');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(document.querySelector('agent-media-viewer')).toBeNull();
      fixture.destroy();
      document.documentElement.classList.remove('dark');
    },
  );
});
