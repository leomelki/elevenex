import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_DRAG_TYPE, SessionRowComponent } from '../../tasks';
import type { ConversationMention } from '../conversation.models';
import { ComposerComponent } from './composer.component';

/** jsdom has no native drag store. Exercise the DOM event boundary with a bounded store. */
function transfer() {
  const data = new Map<string, string>();
  return { effectAllowed: 'none', dropEffect: 'none', files: [], items: [],
    get types() { return [...data.keys()]; },
    setData(type: string, text: string) { data.set(type, text); },
    getData(type: string) { return data.get(type) ?? ''; },
  };
}
function drag(target: Element, type: string, dataTransfer: ReturnType<typeof transfer>, relatedTarget: Element | null = null) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, relatedTarget: { value: relatedTarget } });
  target.dispatchEvent(event);
  return event;
}
beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

describe('session drag to composer', () => {
  function setup() {
    const row = TestBed.createComponent(SessionRowComponent);
    row.componentRef.setInput('session', { id: '12', title: 'Retry work', status: 'done', mentionScope: 'machine-a' });
    row.detectChanges();
    const composer = TestBed.createComponent(ComposerComponent);
    composer.componentRef.setInput('sessionMentionScope', 'machine-a');
    composer.componentRef.setInput('showTools', false);
    composer.componentRef.setInput('draft', 'Review then test');
    composer.detectChanges();
    const mentions: ConversationMention[] = [];
    composer.componentInstance.mentionInserted.subscribe(mention => mentions.push(mention));
    const data = transfer();
    const button = row.nativeElement.querySelector('.select') as HTMLButtonElement;
    const textarea = composer.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.setSelectionRange(7, 7);
    let activated = 0;
    row.componentInstance.activated.subscribe(() => activated++);
    drag(button, 'dragstart', data);
    return { composer, row, textarea, data, mentions, activated: () => activated };
  }
  it('copies a session reference without rewriting the draft and focuses without navigating or sending', () => {
    const { composer, row, textarea, data, mentions, activated } = setup();
    let sends = 0; composer.componentInstance.submitted.subscribe(() => sends++);
    expect(data.types).toEqual([SESSION_DRAG_TYPE]);
    expect(data.effectAllowed).toBe('copy');
    expect(drag(textarea, 'dragover', data).defaultPrevented).toBe(true);
    composer.detectChanges();
    expect(composer.nativeElement.querySelector('.drop-label.visible')?.textContent).toContain('Drop to mention session');
    drag(textarea, 'drop', data); composer.detectChanges();
    expect(mentions).toEqual([{ id: '12', kind: 'session', label: 'Retry work' }]);
    expect(textarea.value).toBe('Review then test');
    expect(textarea.selectionStart).toBe(7);
    expect(document.activeElement).toBe(textarea);
    expect(composer.componentInstance.dropping()).toBeNull();
    expect(activated()).toBe(0); expect(sends).toBe(0);
    drag(row.nativeElement.querySelector('.select'), 'dragend', data);
  });
  it('preserves a selected range and an unfinished @ query when dropping a session', () => {
    const { composer, textarea, data, mentions } = setup();
    textarea.value = 'Review @retry then test';
    textarea.setSelectionRange(7, 13);
    textarea.dispatchEvent(new Event('input', { bubbles: true })); composer.detectChanges();
    drag(textarea, 'drop', data); composer.detectChanges();
    expect(mentions).toHaveLength(1);
    expect(textarea.value).toBe('Review @retry then test');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 13]);
  });
  it('consumes the picker query and keeps the chip as the only session reference', () => {
    const { composer, textarea, mentions } = setup();
    const mention: ConversationMention = { id: '12', kind: 'session', label: 'Retry work' };
    composer.componentInstance.mentionInserted.subscribe(value => composer.componentRef.setInput('context', [value]));
    composer.componentInstance.contextRemoved.subscribe(() => composer.componentRef.setInput('context', []));
    const pick = () => {
      textarea.value = 'Review @retry after'; textarea.setSelectionRange(13, 13);
      textarea.dispatchEvent(new Event('input', { bubbles: true })); composer.detectChanges();
      composer.componentInstance.insertMention(mention); composer.detectChanges();
    };
    pick();
    expect(textarea.value).toBe('Review  after');
    expect(textarea.selectionStart).toBe(7);
    expect(composer.nativeElement.querySelectorAll('ex-mention')).toHaveLength(1);
    pick(); expect(mentions).toHaveLength(1); expect(textarea.value).toBe('Review  after');
    composer.nativeElement.querySelector('ex-mention button').click(); composer.detectChanges();
    expect(composer.nativeElement.querySelector('ex-mention')).toBeNull();
    expect(textarea.value).toBe('Review  after');
    expect(composer.componentInstance.context()).toEqual([]);
  });
  it('rejects foreign scopes, malformed references and disabled/busy drops', () => {
    const { composer, textarea, data, mentions } = setup();
    for (const payload of ['{', JSON.stringify({ id: '12', title: 'Work', scopeId: 'machine-b' }), JSON.stringify({ id: '12', title: 'x'.repeat(1001), scopeId: 'machine-a' })]) {
      data.setData(SESSION_DRAG_TYPE, payload); drag(textarea, 'drop', data);
    }
    data.setData(SESSION_DRAG_TYPE, JSON.stringify({ id: '12', title: 'Work', scopeId: 'machine-a' }));
    for (const input of ['disabled', 'sending', 'mentionsEnabled']) {
      composer.componentRef.setInput(input, input !== 'mentionsEnabled'); composer.detectChanges();
      drag(textarea, 'drop', data);
      composer.componentRef.setInput(input, input === 'mentionsEnabled'); composer.detectChanges();
    }
    expect(mentions).toEqual([]); expect(textarea.value).toBe('Review then test');
  });
  it('ignores duplicate mentions, preserves internal drag movement and clears feedback on exit/cancel', () => {
    const { composer, textarea, data, mentions } = setup();
    composer.componentRef.setInput('context', [{ id: '12', kind: 'session', label: 'Retry work' }]); composer.detectChanges();
    drag(textarea, 'dragover', data);
    drag(textarea, 'dragleave', data, composer.nativeElement.querySelector('.bar'));
    expect(composer.componentInstance.dropping()).toBe('session');
    drag(textarea, 'drop', data);
    expect(mentions).toEqual([]); expect(textarea.value).toBe('Review then test');
    drag(textarea, 'dragover', data); drag(textarea, 'dragleave', data);
    expect(composer.componentInstance.dropping()).toBeNull();
    drag(textarea, 'dragover', data); document.dispatchEvent(new Event('dragend'));
    expect(composer.componentInstance.dropping()).toBeNull();
  });
  it('refuses additional session context at the limit and keeps file attachment drops available', () => {
    const { composer, textarea, data, mentions } = setup();
    composer.componentRef.setInput('context', Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1), kind: 'session', label: 'Context' })));
    composer.detectChanges(); drag(textarea, 'drop', data); composer.detectChanges();
    expect(mentions).toEqual([]); expect(textarea.value).toBe('Review then test');
    expect(composer.nativeElement.querySelector('[role="status"]').textContent).toContain('up to 8');
    composer.componentRef.setInput('mentionsEnabled', false);
    composer.componentRef.setInput('attachmentsEnabled', true); composer.detectChanges();
    const fileData = transfer(), file = new File(['notes'], 'notes.txt');
    fileData.setData('Files', ''); Object.defineProperty(fileData, 'files', { value: [file] });
    const files: (readonly File[])[] = [];
    composer.componentInstance.filesAttached.subscribe(value => files.push(value));
    expect(drag(textarea, 'dragover', fileData).defaultPrevented).toBe(true);
    drag(textarea, 'drop', fileData);
    expect(files).toEqual([[file]]); expect(mentions).toEqual([]);
  });
});
