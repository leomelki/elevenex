import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerQueueComponent } from './composer-queue.component';
import { ComposerComponent } from './composer.component';
import type { ConversationAttachment } from '../conversation.models';
import { chatExchanges } from '../../session-chat/session-chat-transcript';
import { serializeBrowserElements } from '@elevenex/shared';
const reference = { version: 1 as const, id: '11111111-1111-4111-8111-111111111111', label: 'button · Save', tag: 'button', selector: 'button', frames: [], page: 'https://example.com/checkout', tabId: 'tab-1', documentId: 'document-1', capturedAt: '2026-11-09T10:00:00Z', target: { x: 20, y: 30, width: 80, height: 30 }, crop: { x: 0, y: 0, width: 148, height: 108 }, image: { width: 148, height: 108, scale: 1 } };
const file: ConversationAttachment = { id: 'upload-1', element: reference, path: '/stored/element.jpg', name: 'element.jpg', kind: 'image', status: 'ready' };
beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
describe('element mention semantics', () => {
  it('mentions a staged reference at the caret without duplicating its context or modifying user prose', () => {
    const fixture = TestBed.createComponent(ComposerComponent);
    fixture.componentRef.setInput('attachments', [file]); fixture.detectChanges();
    const composer = fixture.componentInstance, mention = vi.fn(); composer.mentionInserted.subscribe(mention);
    composer.draft.set('Align '); fixture.detectChanges();
    const textarea = composer.textarea()!.nativeElement; textarea.setSelectionRange(6, 6);
    composer.mentionElement(file); fixture.detectChanges();
    expect(composer.draft()).toBe('Align @element-11111111 ');
    expect(composer.allMentionItems()).toHaveLength(1); expect(mention).not.toHaveBeenCalled();
    composer.mentionElement(file); expect(composer.allMentionItems()).toHaveLength(1);
    fixture.componentRef.setInput('attachments', []); fixture.detectChanges(); expect(composer.allMentionItems()).toHaveLength(0);
  });
  it('keeps semantic context out of the queued prose editor and retains it when saving', () => {
    const fixture = TestBed.createComponent(ComposerQueueComponent), component = fixture.componentInstance;
    const text = 'Align @element-11111111\n\n' + serializeBrowserElements([{ reference, attachment: 'element.jpg', imageIndex: 1 }]) + '\n\n[element.jpg](</stored/element.jpg>)';
    const saved = vi.fn(); component.edited.subscribe(saved);
    fixture.componentRef.setInput('items', [{ id: 'queued', text }]); fixture.detectChanges();
    component.beginEdit({ id: 'queued', text });
    expect(component.editText()).toBe('Align @element-11111111');
    component.editText.set('Make @element-11111111 wider'); component.save('queued');
    expect(saved.mock.calls[0]?.[0].text).toContain('Make @element-11111111 wider');
    expect(saved.mock.calls[0]?.[0].text).toContain('element.jpg');
    expect(saved.mock.calls[0]?.[0].text).toContain('elevenex_browser_elements_v1');
  });

  it('restores multiple cards and exact media associations from durable history without rendering the envelope', () => {
    const second = { ...reference, id: '22222222-2222-4222-8222-222222222222', label: 'h1 · Checkout' };
    const text = 'Align @element-11111111 with @element-22222222\n\n' + serializeBrowserElements([{ reference, attachment: 'element.jpg', imageIndex: 1 }, { reference: second, attachment: 'heading.jpg', imageIndex: 2 }]) + '\n\n[element.jpg](</stored/element.jpg>)\n\n[heading.jpg](</stored/heading.jpg>)';
    const exchanges = chatExchanges([{ id: 'saved', kind: 'user', text, timestamp: '', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false, media: [{ id: '0', path: '/stored/element.jpg', caption: 'element.jpg', inline: false }, { id: '1', path: '/stored/heading.jpg', caption: 'heading.jpg', inline: false }] }], null, new Set());
    expect(exchanges[0]?.prompt).toBe('Align @element-11111111 with @element-22222222');
    expect(exchanges[0]?.attachments?.map(file => file.element?.id)).toEqual([reference.id, second.id]);
  });
});
