import { TestBed } from '@angular/core/testing';
import { CodeFramePool } from './code-frame-pool.service';

const url = 'https://w-' + 'a'.repeat(32) + '.' + 'b'.repeat(32) + '.code.elevenex.invalid/';
describe('window-owned Code iframe pool', () => {
  const containers: HTMLElement[] = [];
  const moveBefore = Object.getOwnPropertyDescriptor(Element.prototype, 'moveBefore');
  beforeEach(() => {
    // jsdom has no browsing context implementation for moveBefore; the native
    // regression separately checks that real Chromium retains its frame ID.
    vi.stubGlobal('matchMedia', () => ({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value(this: Element, child: Node, before: Node | null) { this.insertBefore(child, before); } });
  });
  afterEach(() => { TestBed.resetTestingModule(); for (const node of containers.splice(0)) node.remove(); vi.unstubAllGlobals(); if (moveBefore) Object.defineProperty(Element.prototype, 'moveBefore', moveBefore); else Reflect.deleteProperty(Element.prototype, 'moveBefore'); });
  function container() { const node = document.createElement('div'); document.body.append(node); containers.push(node); return node; }
  it('retains one sandboxed frame across owner teardown and remount and cleans up with its window', () => {
    const pool = TestBed.inject(CodeFramePool), first = container(), second = container();
    const park = pool.mount(url, first), iframe = first.querySelector('iframe');
    expect(iframe?.title).toBe('Task Code workbench');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    park(); expect(first.querySelector('iframe')).toBeNull(); expect(iframe?.closest('[hidden]')).not.toBeNull();
    pool.mount(url, second); expect(second.querySelector('iframe')).toBe(iframe);
    park(); expect(second.querySelector('iframe')).toBe(iframe); // stale owner cannot take it back
    TestBed.resetTestingModule(); expect(iframe?.isConnected).toBe(false);
  });
  it('rejects arbitrary documents and replaces only frames main has retired', () => {
    const pool = TestBed.inject(CodeFramePool), owner = container();
    for (const unsafe of ['https://example.com/', 'app://elevenex/', url + '?untrusted', url.replace('https:', 'http:')]) expect(() => pool.mount(unsafe, owner)).toThrow();
    pool.mount(url, owner); const iframe = owner.querySelector('iframe'); iframe?.remove();
    pool.mount(url, owner); expect(owner.querySelector('iframe')).not.toBe(iframe); expect(owner.querySelectorAll('ex-code-frame')).toHaveLength(1);
  });
});
