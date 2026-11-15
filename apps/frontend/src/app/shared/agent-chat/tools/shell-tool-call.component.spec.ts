import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { ShellToolCallComponent } from './shell-tool-call.component';

const call: AgentTranscriptItem = {
  id: 'shell',
  kind: 'tool_use',
  toolUseId: 'shell',
  toolName: 'Bash',
  toolInput: { cmd: 'pnpm test', description: 'Run tests', workdir: '/repo' },
  timestamp: '',
};
const result: AgentTranscriptItem = {
  id: 'result',
  kind: 'tool_result',
  toolUseId: 'shell',
  content: 'PASS\nTests: 42 passed\n',
  timestamp: '',
};

async function setup(receipt: AgentTranscriptItem | null = result) {
  await TestBed.configureTestingModule({ imports: [ShellToolCallComponent] }).compileComponents();
  const fixture = TestBed.createComponent(ShellToolCallComponent);
  fixture.componentRef.setInput('call', call);
  fixture.componentRef.setInput('result', receipt);
  fixture.detectChanges();
  return fixture;
}

describe('ShellToolCallComponent', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    vi.restoreAllMocks();
  });

  it.each(['light', 'dark'])(
    'shows a useful collapsed receipt and accessible expanded controls in %s',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const fixture = await setup();
      const host: HTMLElement = fixture.nativeElement;
      const toggle = host.querySelector<HTMLButtonElement>('.cw-tool__head')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.textContent).toContain('Run tests');
      expect(toggle.textContent).toContain('pnpm test');
      expect(toggle.textContent).toContain('Tests: 42 passed');
      expect(host.querySelector('pre')).toBeNull();
      toggle.click();
      fixture.detectChanges();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(host.querySelector('.cw-shell__command')?.textContent).toBe('pnpm test');
      expect(host.textContent).toContain('/repo');
      expect(host.querySelector('.cw-shell__output')?.textContent).toBe(result.content);
      const wrap = host.querySelector<HTMLButtonElement>('[aria-label="Wrap output lines"]')!;
      expect(wrap.getAttribute('aria-pressed')).toBe('true');
      wrap.click();
      fixture.detectChanges();
      expect(wrap.getAttribute('aria-pressed')).toBe('false');
      expect(host.querySelector('.cw-shell__output--wrap')).toBeNull();
      toggle.click();
      fixture.detectChanges();
      expect(host.querySelector('[aria-label="Copy output"]')).toBeNull();
      fixture.destroy();
    },
  );

  it('opens failures, respects an explicit collapse and never executes output HTML', async () => {
    const fixture = await setup({
      ...result,
      isError: true,
      content: '<img src=x onerror="alert(1)">\nfailed',
    });
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('.cw-tool')?.getAttribute('data-state')).toBe('error');
    expect(host.querySelector('.cw-shell__output')?.textContent).toContain('<img');
    expect(host.querySelector('img')).toBeNull();
    fixture.componentInstance.toggle();
    fixture.detectChanges();
    fixture.componentRef.setInput('result', { ...result, isError: true, content: 'still failed' });
    fixture.detectChanges();
    expect(host.querySelector('.cw-tool__body')).toBeNull();
    fixture.componentRef.setInput('call', { ...call, id: 'another' });
    fixture.detectChanges();
    expect(host.querySelector('.cw-tool__body')).not.toBeNull();
    fixture.destroy();
  });

  it('shows empty and incomplete results honestly and changes from running to completed', async () => {
    const fixture = await setup(null);
    expect(fixture.componentInstance.view().state).toBe('incomplete');
    fixture.componentRef.setInput('isLive', true);
    fixture.componentRef.setInput('elapsedSeconds', 12);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Running 12s');
    fixture.componentInstance.toggle();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Waiting for output');
    fixture.componentRef.setInput('result', { ...result, content: '' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Command completed without output.');
    fixture.destroy();
  });

  it('bounds expanded output while copying the entire captured text and exact command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const text = Array.from({ length: 1400 }, (_, i) => `line ${i}`).join('\n');
      const fixture = await setup({ ...result, content: text });
      fixture.componentInstance.toggle();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('.cw-shell__output').textContent.split('\n'),
      ).toHaveLength(200);
      await fixture.componentInstance.copy('output');
      fixture.detectChanges();
      expect(writeText).toHaveBeenLastCalledWith(text);
      expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toBe(
        'Output copied.',
      );
      await fixture.componentInstance.copy('command');
      expect(writeText).toHaveBeenLastCalledWith('pnpm test');
      fixture.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps large commands bounded and allows earlier output to be shown and hidden', async () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
    const fixture = await setup({ ...result, content: text });
    fixture.componentRef.setInput('call', { ...call, toolInput: { command: 'x'.repeat(50_000) } });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.cw-tool__head')!.textContent!.length).toBeLessThan(1000);
    fixture.componentInstance.toggle();
    fixture.detectChanges();
    expect(host.querySelector('.cw-shell__command')?.textContent?.length).toBe(24_000);
    fixture.componentInstance.toggleOutput();
    fixture.detectChanges();
    expect(host.querySelector('.cw-shell__output')?.textContent).toBe(text);
    expect(host.textContent).toContain('Show less');
    fixture.componentInstance.toggleOutput();
    fixture.detectChanges();
    expect(host.querySelector('.cw-shell__output')?.textContent?.split('\n')).toHaveLength(200);
    fixture.destroy();
  });

  it('reports clipboard failure and ignores clipboard completion after destruction', async () => {
    let finish: (() => void) | undefined;
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('Denied'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const fixture = await setup();
      await fixture.componentInstance.copy('command');
      expect(fixture.componentInstance.copyFeedback()).toContain('Could not copy');
      const pending = fixture.componentInstance.copy('output');
      fixture.destroy();
      finish!();
      await pending;
      expect(fixture.componentInstance.copyFeedback()).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
