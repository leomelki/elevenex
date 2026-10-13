import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPreviewService } from '@/shared/services/review-preview.service';
import {
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
} from '@/shared/models/review-preview-bridge.model';
import { AgentMarkdownComponent } from './agent-markdown.component';

const directive = (path: string) => `visualize${JSON.stringify({ path })}`;
const previewId = 'preview-test-id';

async function mount(content: string, options: { fakeTimers?: boolean } = {}) {
  const preview = {
    session: vi.fn().mockResolvedValue({
      previewId,
      urlPrefix: `http://backend.test/api/review-preview/p/${previewId}/`,
    }),
    keepalive: vi.fn().mockResolvedValue([]),
    invalidateSession: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [AgentMarkdownComponent],
    providers: [{ provide: ReviewPreviewService, useValue: preview }],
  }).compileComponents();
  if (options.fakeTimers) vi.useFakeTimers();
  const fixture = TestBed.createComponent(AgentMarkdownComponent);
  fixture.componentRef.setInput('content', content);
  fixture.componentRef.setInput('worktreePath', '/tmp/repo');
  fixture.detectChanges();
  if (options.fakeTimers) await vi.advanceTimersByTimeAsync(1);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, preview, host: fixture.nativeElement as HTMLElement };
}

function reply(frame: HTMLIFrameElement, payload: object, overrides: object = {}) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: frame.contentWindow,
      data: { ex: PREVIEW_BRIDGE_CHANNEL, v: PREVIEW_BRIDGE_VERSION, previewId, ...payload },
      ...overrides,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
  document.documentElement.style.removeProperty('--foreground');
  document.documentElement.style.removeProperty('--chart-1');
});

describe('AgentMarkdownComponent visualization embeds', () => {
  it('keeps directives inside quotes and lists as literal Markdown', async () => {
    const quote = `> ${directive('/tmp/quoted.html')}`;
    const list = `- ${directive('/tmp/listed.html')}`;
    const { fixture, preview, host } = await mount(
      `${quote}\n\n${directive('/tmp/chart.html')}\n\n${list}`,
    );
    expect(host.querySelectorAll('agent-visualization')).toHaveLength(1);
    expect(host.querySelector('blockquote')?.textContent).toContain('quoted.html');
    expect(host.querySelector('li')?.textContent).toContain('listed.html');
    expect(preview.session).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('defers preview requests until an artifact approaches the viewport', async () => {
    let intersect!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    const { fixture, preview, host } = await mount(directive('/tmp/chart.html'));
    expect(preview.session).not.toHaveBeenCalled();
    expect(host.querySelector('iframe')).toBeNull();
    intersect(
      [
        {
          isIntersecting: false,
          target: host.querySelector('agent-visualization')!,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    fixture.detectChanges();
    expect(preview.session).not.toHaveBeenCalled();
    intersect(
      [
        {
          isIntersecting: true,
          target: host.querySelector('agent-visualization')!,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(preview.session).toHaveBeenCalledTimes(1);
    expect(host.querySelector('iframe')).not.toBeNull();
    expect(disconnect).toHaveBeenCalled();
    fixture.destroy();
  });

  it.each(['light', 'dark'])(
    'renders a sandboxed visualization with live theme updates in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.style.setProperty('--foreground', 'rgb(40, 50, 60)');
      document.documentElement.style.setProperty('--chart-1', 'rgb(10, 20, 30)');
      const { fixture, preview, host } = await mount(
        `${directive('/tmp/artifacts/chart.html')}\n\n**Estimated cost** [Pricing][api]\n\n[api]: https://example.test`,
      );
      const frame = host.querySelector('iframe')!;
      expect(frame).not.toBeNull();
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(frame.getAttribute('loading')).toBe('eager');
      expect(preview.session).toHaveBeenCalledWith('/tmp/artifacts', true, true);
      expect(host.querySelector('strong')?.textContent).toBe('Estimated cost');
      expect(host.querySelector('a')?.href).toBe('https://example.test/');
      const post = vi.spyOn(frame.contentWindow!, 'postMessage');
      reply(frame, { type: 'ready', title: 'Token usage', contentHeight: 640 });
      fixture.detectChanges();
      expect(frame.title).toBe('Token usage');
      expect(frame.style.height).toBe('640px');
      expect(host.querySelector('[role="status"]')).toBeNull();
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'init',
          theme: expect.objectContaining({
            colorScheme: theme,
            variables: expect.objectContaining({
              '--foreground': 'rgb(40, 50, 60)',
              '--viz-series-1': 'rgb(10, 20, 30)',
            }),
          }),
        }),
        '*',
      );
      document.documentElement.classList.toggle('dark');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({
          theme: expect.objectContaining({ colorScheme: theme === 'dark' ? 'light' : 'dark' }),
        }),
        '*',
      );
      expect(host.querySelector('iframe')).toBe(frame);
      fixture.destroy();
    },
  );

  it('preserves the iframe and its URL when surrounding Markdown streams', async () => {
    const content = directive('/tmp/chart.html');
    const { fixture, preview, host } = await mount(content);
    const frame = host.querySelector('iframe')!;
    const src = frame.src;
    fixture.componentRef.setInput('content', `${content}\n\nMore **text**`);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector('iframe')).toBe(frame);
    expect(frame.src).toBe(src);
    expect(preview.session).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('rejects spoofed messages and bounds authenticated resize messages', async () => {
    const { fixture, host } = await mount(directive('/tmp/chart.html'));
    const frame = host.querySelector('iframe')!;
    reply(frame, { type: 'ready', contentHeight: 9999 }, { source: window });
    fixture.detectChanges();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    reply(frame, { type: 'ready', contentHeight: 9999 });
    fixture.detectChanges();
    expect(frame.style.height).toBe('1200px');
    reply(frame, { type: 'resize', contentHeight: NaN });
    fixture.detectChanges();
    expect(frame.style.height).toBe('1200px');
    reply(frame, { type: 'resize', contentHeight: -1 });
    fixture.detectChanges();
    expect(frame.style.height).toBe('160px');
    fixture.destroy();
  });

  it('requires a fresh bridge handshake after every iframe load', async () => {
    const { fixture, host } = await mount(directive('/tmp/chart.html'));
    const frame = host.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    vi.useFakeTimers();
    try {
      reply(frame, { type: 'ready', contentHeight: 320 });
      frame.dispatchEvent(new Event('load'));
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'probe', previewId }),
        '*',
      );
      reply(frame, { type: 'ready', contentHeight: 320 });
      vi.advanceTimersByTime(1500);
      fixture.detectChanges();
      expect(host.querySelector('[role="alert"]')).toBeNull();
      frame.dispatchEvent(new Event('load'));
      vi.advanceTimersByTime(1500);
      fixture.detectChanges();
      expect(host.querySelector('iframe')).toBeNull();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('navigated away');
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });

  it('preserves dependency failures across DOM readiness and the load/probe handshake', async () => {
    const { fixture, host } = await mount(directive('/tmp/chart.html'));
    const frame = host.querySelector('iframe')!;
    reply(frame, { type: 'error', message: 'Blocked script' });
    fixture.detectChanges();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    reply(frame, { type: 'ready', contentHeight: 320 });
    frame.dispatchEvent(new Event('load'));
    reply(frame, { type: 'ready', contentHeight: 320 });
    fixture.detectChanges();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not load');
    host.querySelector<HTMLButtonElement>('[aria-label="Reload visualization"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    fixture.destroy();
  });

  it('times out a document without load or ready and ignores its late messages', async () => {
    const { fixture, host } = await mount(directive('/tmp/chart.html'), { fakeTimers: true });
    const frame = host.querySelector('iframe')!;
    vi.advanceTimersByTime(30_000);
    fixture.detectChanges();
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('too long');
    reply(frame, { type: 'ready', contentHeight: 320 });
    fixture.detectChanges();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('too long');
    fixture.destroy();
  });

  it('follows authenticated local HTML links, retains URL parameters, and restores the original on reload', async () => {
    const { fixture, host, preview } = await mount(directive('/tmp/chart.html'));
    const first = host.querySelector('iframe')!;
    reply(first, {
      type: 'navigate',
      external: false,
      href: `http://backend.test/api/review-preview/p/${previewId}/details.html?view=cost#totals`,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const next = host.querySelector('iframe')!;
    expect(next).not.toBe(first);
    expect(new URL(next.src).pathname).toContain('/details.html');
    expect(new URL(next.src).searchParams.get('view')).toBe('cost');
    expect(new URL(next.src).hash).toBe('#totals');
    reply(first, { type: 'ready', title: 'Stale page', contentHeight: 999 });
    fixture.detectChanges();
    expect(next.title).not.toBe('Stale page');
    host.querySelector<HTMLButtonElement>('[aria-label="Reload visualization"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(new URL(host.querySelector('iframe')!.src).pathname).toContain('/chart.html');
    expect(preview.session).toHaveBeenCalledTimes(3);
    fixture.destroy();
  });

  it('gives feedback for external and forged internal URLs without clearing resource errors', async () => {
    const { fixture, host, preview } = await mount(directive('/tmp/chart.html'));
    const frame = host.querySelector('iframe')!;
    reply(frame, { type: 'error', message: 'Missing resource' });
    for (const href of [
      'https://example.test/',
      'javascript:alert(1)',
      'http://backend.test/api/files',
    ]) {
      reply(frame, { type: 'navigate', external: false, path: 'fake.html', href });
      fixture.detectChanges();
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Only local HTML');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not load');
      expect(host.querySelector('iframe')).toBe(frame);
    }
    expect(preview.session).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('renews a mounted frame when the shared heartbeat reports backend expiry', async () => {
    const { fixture, preview, host } = await mount(directive('/tmp/chart.html'), {
      fakeTimers: true,
    });
    reply(host.querySelector('iframe')!, { type: 'ready', contentHeight: 320 });
    const first = host.querySelector('iframe')!;
    preview.keepalive.mockResolvedValueOnce([previewId]);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(preview.session).toHaveBeenCalledTimes(2);
    expect(host.querySelector('iframe')).not.toBe(first);
    fixture.destroy();
  });

  it('shows an error for unsupported paths without opening a preview', async () => {
    const { fixture, preview, host } = await mount(directive('https://evil.test/chart.html'));
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('local HTML');
    expect(preview.session).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('retries unavailable files and ignores superseded async loads', async () => {
    const { fixture, preview, host } = await mount(directive('/tmp/chart.html'));
    let complete!: (session: { previewId: string; urlPrefix: string }) => void;
    preview.session.mockImplementationOnce(
      () =>
        new Promise<{ previewId: string; urlPrefix: string }>((resolve) => {
          complete = resolve;
        }),
    );
    host.querySelector<HTMLButtonElement>('[aria-label="Reload visualization"]')!.click();
    fixture.detectChanges();
    expect(preview.session).toHaveBeenLastCalledWith('/tmp', true, true);
    fixture.componentRef.setInput('content', directive('/tmp/other.html'));
    fixture.detectChanges();
    complete({ previewId: 'stale', urlPrefix: 'http://backend.test/stale/' });
    await fixture.whenStable();
    const frame = host.querySelector('iframe')!;
    expect(frame.src).not.toContain('stale.html');
    preview.session.mockRejectedValueOnce(new Error('Missing file'));
    host.querySelector<HTMLButtonElement>('[aria-label="Reload visualization"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Visualization unavailable',
    );
    expect(host.querySelector('iframe')).toBeNull();
    fixture.destroy();
  });
});
