import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBrowserElements, serializeBrowserElements } from '@elevenex/shared';
import { ComposerQueueComponent } from './composer-queue.component';
import { ComposerComponent } from './composer.component';
import { MentionMenuComponent } from './mention-menu.component';
import type { ConversationAttachment } from '../conversation.models';
import { ElementProseComponent } from '../element/element-prose.component';
import { thumbnailFrame } from '../element/element-geometry';
import { chatExchanges } from '../../session-chat/session-chat-transcript';

const reference = { version: 1 as const, id: '11111111-1111-4111-8111-111111111111', label: 'button · Save', tag: 'button', selector: 'button', frames: [], page: 'https://example.com/checkout', tabId: 'tab-1', documentId: 'document-1', capturedAt: '2026-11-09T10:00:00Z', target: { x: 20, y: 30, width: 80, height: 30 }, crop: { x: 0, y: 0, width: 148, height: 108 }, image: { width: 148, height: 108, scale: 1 } };
const second = { ...reference, id: '22222222-2222-4222-8222-222222222222', label: 'h1 · Checkout' };
const file: ConversationAttachment = { id: 'upload-1', element: reference, marker: 1, path: '/stored/element.jpg', name: 'element.jpg', kind: 'image', status: 'ready' };
const other: ConversationAttachment = { id: 'upload-2', element: second, marker: 2, path: '/stored/heading.jpg', name: 'heading.jpg', kind: 'image', status: 'ready' };

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

function mount(attachments: readonly ConversationAttachment[] = [file, other]) {
  const fixture = TestBed.createComponent(ComposerComponent);
  fixture.componentRef.setInput('attachments', attachments);
  fixture.componentRef.setInput('elementPickAvailable', true);
  fixture.detectChanges();
  return { fixture, composer: fixture.componentInstance, textarea: fixture.componentInstance.textarea()!.nativeElement };
}

describe('element pins in the composer', () => {
  it('drops a pin at the caret, spaced from the words around it', () => {
    const { fixture, composer, textarea } = mount([file]);
    composer.draft.set('Alignwith the heading'); fixture.detectChanges();
    textarea.setSelectionRange(5, 5);
    composer.insertElement(1); fixture.detectChanges();
    expect(composer.draft()).toBe('Align ❶ with the heading');
    expect(textarea.selectionStart).toBe('Align ❶ '.length);
  });
  it('renders staged elements as chips beside the prose, with unreferenced pins hollow', () => {
    const { fixture, composer } = mount();
    composer.draft.set('Make ❶ wider'); fixture.detectChanges();
    const chips = [...fixture.nativeElement.querySelectorAll('.context ex-element-chip')] as HTMLElement[];
    expect(chips).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('ex-attachments')).toBeNull();
    expect(chips[0]!.querySelector('ex-element-pin')!.classList.contains('hollow')).toBe(false);
    expect(chips[1]!.querySelector('ex-element-pin')!.classList.contains('hollow')).toBe(true);
    expect(chips[1]!.querySelector('.face')!.getAttribute('aria-label')).toContain('not referenced');
    expect(fixture.nativeElement.querySelectorAll('.marker-text mark')).toHaveLength(1);
  });
  it('removes a chip together with its pins, so no marker points at nothing', () => {
    const { fixture, composer } = mount();
    const removed = vi.fn(); composer.attachmentRemoved.subscribe(removed);
    composer.draft.set('Align ❶ with ❷ and ❷ again'); fixture.detectChanges();
    composer.removeElement(other); fixture.detectChanges();
    expect(composer.draft()).toBe('Align ❶ with and again');
    expect(removed).toHaveBeenCalledWith('upload-2');
  });
  it('lists staged elements first in the @ menu and inserts the pin instead of an @ label', () => {
    const { fixture, composer, textarea } = mount();
    composer.draft.set('Align @'); fixture.detectChanges(); textarea.setSelectionRange(7, 7);
    const mention = vi.fn(); composer.mentionInserted.subscribe(mention);
    expect(composer.allMentionItems().slice(0, 2).map(item => [item.kind, item.marker, item.label])).toEqual([['element', 1, 'button · Save'], ['element', 2, 'h1 · Checkout']]);
    composer.insertMention(composer.allMentionItems()[1]!); fixture.detectChanges();
    expect(composer.draft()).toBe('Align ❷ ');
    expect(mention).not.toHaveBeenCalled();
  });
  it('offers pointing at a new element from the @ menu and the bar, consuming the query', () => {
    const { fixture, composer, textarea } = mount([file]);
    const picks = vi.fn(); composer.elementPickRequested.subscribe(picks);
    composer.draft.set('Align @po'); fixture.detectChanges(); textarea.setSelectionRange(9, 9);
    composer.pickFromMentions();
    expect(composer.draft()).toBe('Align ');
    fixture.nativeElement.querySelector('ex-icon-button[label="Point at an element in the browser"] button').click();
    expect(picks).toHaveBeenCalledTimes(2);
  });
  it('stops offering picks once a message holds eight elements', () => {
    const files = Array.from({ length: 8 }, (_, index) => ({ ...file, id: 'f' + index, marker: index + 1, element: { ...reference, id: `${index}1111111-1111-4111-8111-111111111111` } }));
    const { composer } = mount(files);
    const picks = vi.fn(); composer.elementPickRequested.subscribe(picks);
    composer.requestElementPick();
    expect(picks).not.toHaveBeenCalled();
    expect(composer.dropAnnouncement()).toContain('up to 8');
  });
});

describe('mention menu command', () => {
  it('reaches the trailing command by keyboard and runs it with Enter', () => {
    const fixture = TestBed.createComponent(MentionMenuComponent);
    fixture.componentRef.setInput('items', [{ id: reference.id, kind: 'element', label: reference.label, marker: 1 }]);
    fixture.componentRef.setInput('actionLabel', 'Point at an element in the browser');
    fixture.detectChanges();
    const action = vi.fn(), selected = vi.fn();
    fixture.componentInstance.action.subscribe(action); fixture.componentInstance.selected.subscribe(selected);
    fixture.componentInstance.onKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(fixture.componentInstance.activeOptionId()).toMatch(/-1$/);
    fixture.componentInstance.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(action).toHaveBeenCalledTimes(1); expect(selected).not.toHaveBeenCalled();
  });
});

describe('element pins in history', () => {
  it('draws pins inline in sent prose and leaves unmatched markers as written', () => {
    const fixture = TestBed.createComponent(ElementProseComponent);
    fixture.componentRef.setInput('text', 'Align ❶ with ❸');
    fixture.componentRef.setInput('attachments', [file]);
    fixture.detectChanges();
    const pins = fixture.nativeElement.querySelectorAll('.pin');
    expect(pins).toHaveLength(1);
    expect(pins[0].getAttribute('aria-label')).toBe('pin 1, button · Save');
    expect(fixture.nativeElement.textContent).toContain('❸');
  });
  it('keeps semantic context out of the queued prose editor and retains it when saving', () => {
    const fixture = TestBed.createComponent(ComposerQueueComponent), component = fixture.componentInstance;
    const text = 'Align ❶\n\n' + serializeBrowserElements([{ reference, marker: 1, attachment: 'element.jpg', imageIndex: 1 }]) + '\n\n[element.jpg](</stored/element.jpg>)';
    const saved = vi.fn(); component.edited.subscribe(saved);
    fixture.componentRef.setInput('items', [{ id: 'queued', text }]); fixture.detectChanges();
    expect(component.preview(text)).toBe('Align ❶');
    component.beginEdit({ id: 'queued', text });
    expect(component.editText()).toBe('Align ❶');
    component.editText.set('Make ❶ wider'); component.save('queued');
    const edited = saved.mock.calls[0]?.[0].text as string;
    expect(edited).toContain('Make ❶ wider');
    expect(edited).toContain('[element.jpg](</stored/element.jpg>)');
    expect(parseBrowserElements(edited).elements[0]).toMatchObject({ marker: 1, attachment: 'element.jpg' });
  });
  it('restores pins and exact media associations from durable history without rendering the envelope', () => {
    const text = 'Align ❷ with ❶\n\n' + serializeBrowserElements([{ reference, marker: 2, attachment: 'element.jpg', imageIndex: 1 }, { reference: second, marker: 1, attachment: 'heading.jpg', imageIndex: 2 }]) + '\n\n[element.jpg](</stored/element.jpg>)\n\n[heading.jpg](</stored/heading.jpg>)';
    const exchanges = chatExchanges([{ id: 'saved', kind: 'user', text, timestamp: '', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false, media: [{ id: '0', path: '/stored/element.jpg', caption: 'element.jpg', inline: false }, { id: '1', path: '/stored/heading.jpg', caption: 'heading.jpg', inline: false }] }], null, new Set());
    expect(exchanges[0]?.prompt).toBe('Align ❷ with ❶');
    expect(exchanges[0]?.attachments?.map(file => [file.element?.id, file.marker])).toEqual([[reference.id, 2], [second.id, 1]]);
  });
});

describe('element thumbnails', () => {
  it('frames the target, covers the box and keeps the image inside it', () => {
    for (const element of [reference, { ...reference, target: { x: 0, y: 0, width: 148, height: 108 } }, { ...reference, target: { x: 140, y: 100, width: 4, height: 4 } }]) {
      const { image, target } = thumbnailFrame(element, 36, 26);
      expect(image.left).toBeLessThanOrEqual(0); expect(image.top).toBeLessThanOrEqual(0);
      expect(image.left + image.width).toBeGreaterThanOrEqual(36 - 1e-9); expect(image.top + image.height).toBeGreaterThanOrEqual(26 - 1e-9);
      expect(image.width / element.image.width).toBeLessThanOrEqual(1.5);
      expect(target.width).toBeGreaterThan(0);
    }
  });
});
