import { TestBed, DeferBlockBehavior, DeferBlockState } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatComponent } from './chat.component';
import type { ChatExchange } from '../conversation.models';

afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

it('defers unvisited replies while keeping visited views and anchors across history updates', async () => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('IntersectionObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener(): void {}, removeEventListener(): void {}, addListener(): void {}, removeListener(): void {} }));
  TestBed.configureTestingModule({ imports: [ChatComponent], deferBlockBehavior: DeferBlockBehavior.Manual });
  const fixture = TestBed.createComponent(ChatComponent);
  const exchanges: readonly ChatExchange[] = Array.from({ length: 80 }, (_, i) => ({ id: String(i), prompt: `Prompt ${i}`, answer: `Reply ${i}`, steps: [], status: 'done' }));
  fixture.componentRef.setInput('renderHistoryWindow', true);
  fixture.componentRef.setInput('exchanges', exchanges);
  fixture.detectChanges(); await fixture.whenStable();
  const root: HTMLElement = fixture.nativeElement;
  expect(root.querySelectorAll('[data-chat-anchor]').length).toBe(160);
  expect(root.querySelectorAll('.reply-placeholder').length).toBe(80);
  const blocks = await fixture.getDeferBlocks();
  await blocks[0]!.render(DeferBlockState.Complete);
  const visited = root.querySelector('ex-turn');
  expect(visited?.textContent).toContain('Reply 0');
  fixture.componentRef.setInput('exchanges', exchanges.slice(0, 35));
  fixture.detectChanges(); await fixture.whenStable();
  expect(root.querySelector('ex-turn')).toBe(visited);
  fixture.destroy();
});
