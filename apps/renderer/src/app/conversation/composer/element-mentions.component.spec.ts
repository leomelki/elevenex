import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBrowserElements, serializeBrowserElements } from '@elevenex/shared';
import { ComposerQueueComponent } from './composer-queue.component';
import { ComposerComponent } from './composer.component';
import { MentionMenuComponent } from './mention-menu.component';
import type { ConversationAttachment } from '../conversation.models';
import { AttachmentsComponent } from '../chat/attachments.component';
import { displayElementMentions, elementMentionNames, encodeElementMentions } from '../element/element-mention-text';
import { ElementProseComponent } from '../element/element-prose.component';
import { editorText } from './element-editor-dom';
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
  return { fixture, composer: fixture.componentInstance, editor: fixture.componentInstance.elementEditor()!, surface: fixture.componentInstance.elementEditor()!.surface()!.nativeElement };
}

describe('element pins in the composer', () => {
  it('drops a pin at the caret, spaced from the words around it', () => {
    const { fixture, composer, editor } = mount([file]);
    composer.draft.set('Alignwith the heading'); fixture.detectChanges();
    editor.setSelection({ start: 5, end: 5 });
    composer.insertElement(1); fixture.detectChanges();
    expect(composer.draft()).toBe('Align ❶ with the heading');
    expect(editorText(editor.surface()!.nativeElement)).toBe('Align ❶ with the heading');
    expect(editor.selection().start).toBe('Align ❶ '.length);
  });
  it('renders named chips inside the editor without a duplicated context row', () => {
    const { fixture, composer } = mount();
    composer.draft.set('Make ❶ wider'); fixture.detectChanges();
    const chips = [...fixture.nativeElement.querySelectorAll('ex-element-editor ex-element-chip')] as HTMLElement[];
    expect(chips).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('ex-attachments')).toBeNull();
    expect(chips[0]!.textContent).toContain('Save');
    expect(chips[0]!.querySelector('ex-element-pin')).toBeNull();
    expect(fixture.nativeElement.querySelector('.context ex-element-chip')).toBeNull();
    expect(fixture.nativeElement.querySelector('.staged-elements')?.textContent).toContain('Checkout');
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
    const { fixture, composer, editor } = mount();
    composer.draft.set('Align @'); fixture.detectChanges(); editor.setSelection({ start: 7, end: 7 });
    const mention = vi.fn(); composer.mentionInserted.subscribe(mention);
    expect(composer.allMentionItems().slice(0, 2).map(item => [item.kind, item.marker, item.label])).toEqual([['element', 1, 'button · Save'], ['element', 2, 'h1 · Checkout']]);
    composer.insertMention(composer.allMentionItems()[1]!); fixture.detectChanges();
    expect(composer.draft()).toBe('Align ❷ ');
    expect(mention).not.toHaveBeenCalled();
  });
  it('offers pointing at a new element from the @ menu and the bar, consuming the query', () => {
    const { fixture, composer, editor } = mount([file]);
    const picks = vi.fn(); composer.elementPickRequested.subscribe(picks);
    composer.draft.set('Align @po'); fixture.detectChanges(); editor.setSelection({ start: 9, end: 9 });
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
  it('draws inspectable names inline and leaves unmatched markers as written', () => {
    const fixture = TestBed.createComponent(ElementProseComponent);
    fixture.componentRef.setInput('text', 'Align ❶ with ❸');
    fixture.componentRef.setInput('attachments', [file]);
    fixture.detectChanges();
    const mentions = fixture.nativeElement.querySelectorAll('ex-element-chip .face');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].getAttribute('aria-label')).toBe('button · Save. Show snapshot');
    expect(mentions[0].textContent).toContain('Save');
    expect(fixture.nativeElement.querySelector('ex-element-pin')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('❸');
  });
  it('omits duplicate cards for inline mentions and keeps unmentioned elements and ordinary files', () => {
    const fixture = TestBed.createComponent(AttachmentsComponent);
    fixture.componentRef.setInput('files', [file, other, { id: 'notes', name: 'notes.txt', path: '/notes.txt', kind: 'file', status: 'ready' }]);
    fixture.componentRef.setInput('mentionedText', 'Make ❶ wider'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ex-element-chip')).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('Checkout');
    expect(fixture.nativeElement.textContent).toContain('notes.txt');
    fixture.componentRef.setInput('mentionedText', ''); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ex-element-chip')).toHaveLength(2);
  });
  it('keeps semantic context out of the queued prose editor and retains it when saving', () => {
    const fixture = TestBed.createComponent(ComposerQueueComponent), component = fixture.componentInstance;
    const text = 'Align ❶\n\n' + serializeBrowserElements([{ reference, marker: 1, attachment: 'element.jpg', imageIndex: 1 }]) + '\n\n[element.jpg](</stored/element.jpg>)';
    const saved = vi.fn(); component.edited.subscribe(saved);
    fixture.componentRef.setInput('items', [{ id: 'queued', text }]); fixture.detectChanges();
    expect(component.preview(text)).toBe('Align @“Save”');
    component.beginEdit({ id: 'queued', text });
    expect(component.editText()).toBe('Align @“Save”');
    component.editText.set('Make @“Save” wider'); component.save('queued');
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

describe('named element draft projection', () => {
  it('round trips repeated, multiline, quoted and equal labels without changing durable identity', () => {
    const names = elementMentionNames([file, { ...other, element: { ...second, label: 'button · Save' } }]);
    const wire = 'Align ❶ with ❷\nthen ❶ again';
    const display = displayElementMentions(wire, names);
    expect(display).toBe('Align @“Save” with @“Save · 2”\nthen @“Save” again');
    expect(encodeElementMentions(display, names)).toBe(wire);
    expect(encodeElementMentions('Make @“Sav” wider', names)).toBe('Make @“Sav” wider');
  });
  it('keeps native selection offsets correct when inserting after an existing named mention', () => {
    const { fixture, composer, editor } = mount();
    composer.draft.set('Align ❶ with @'); fixture.detectChanges();
    editor.setSelection({ start: composer.draft().length, end: composer.draft().length });
    composer.insertMention(composer.allMentionItems()[1]!); fixture.detectChanges();
    expect(composer.draft()).toBe('Align ❶ with ❷ ');
    expect(editorText(editor.surface()!.nativeElement)).toBe('Align ❶ with ❷ ');
    expect(editor.selection().start).toBe(composer.draft().length);
  });
  it('submits marker identities after native input while preserving copyable labels in the editor', () => {
    const { fixture, composer, editor } = mount();
    editor.replace(0, 0, 'Make ❶ wider'); fixture.detectChanges();
    const sent = vi.fn(); composer.submitted.subscribe(sent);
    composer.send();
    expect(sent.mock.calls[0]?.[0].text).toBe('Make ❶ wider');
  });
});

describe('inline element editing', () => {
  it.each([0, 1, 2])('removes only occurrence %i of a repeated element and keeps its attachment', (occurrence) => {
    const { fixture, composer, surface } = mount();
    const removed = vi.fn(); composer.attachmentRemoved.subscribe(removed);
    const text = '😀 ❶ first\n❷ then ❶ middle and ❶ last';
    composer.draft.set(text); fixture.detectChanges();
    const chips = surface.querySelectorAll<HTMLElement>('ex-element-chip[data-editor-marker="1"]');
    chips[occurrence]!.querySelector<HTMLButtonElement>('button[title="Remove"]')!.click(); fixture.detectChanges();
    const offset = [...text.matchAll(/❶/g)][occurrence]!.index;
    const expected = text.slice(0, offset) + text.slice(offset + 1);
    expect(composer.draft()).toBe(expected);
    expect(editorText(surface)).toBe(expected);
    expect(surface.querySelectorAll('[data-editor-marker="1"]')).toHaveLength(2);
    expect(surface.querySelectorAll('[data-editor-marker="2"]')).toHaveLength(1);
    expect(removed).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.staged-elements')).toBeNull();
    expect(document.activeElement).toBe(surface);
  });
  it('undoes repeated-mention removal and resolves its position again after further edits', () => {
    const { fixture, composer, editor, surface } = mount([file]);
    composer.draft.set('❶ first and ❶ second'); fixture.detectChanges();
    const removeSecond = () => {
      surface.querySelectorAll('ex-element-chip')[1]!.querySelector<HTMLButtonElement>('button[title="Remove"]')!.click(); fixture.detectChanges();
    };
    removeSecond();
    expect(composer.draft()).toBe('❶ first and  second');
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(composer.draft()).toBe('❶ first and ❶ second');
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(composer.draft()).toBe('❶ first and  second');
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    editor.replace(0, 0, 'Compare '); fixture.detectChanges();
    removeSecond();
    expect(composer.draft()).toBe('Compare ❶ first and  second');
    const sent = vi.fn(); composer.submitted.subscribe(sent); composer.send();
    expect(sent.mock.calls[0]?.[0].text).toBe('Compare ❶ first and  second');
    expect(composer.attachments()).toEqual([file]);
  });
  it('releases the attachment only when its final inline occurrence is explicitly removed', () => {
    const { fixture, composer, surface } = mount([file]);
    const removed = vi.fn((id: string) => fixture.componentRef.setInput('attachments', composer.attachments().filter(file => file.id !== id)));
    composer.attachmentRemoved.subscribe(removed);
    composer.draft.set('❶ and ❶'); fixture.detectChanges();
    surface.querySelector<HTMLButtonElement>('button[title="Remove"]')!.click(); fixture.detectChanges();
    expect(composer.draft()).toBe(' and ❶');
    expect(removed).not.toHaveBeenCalled();
    surface.querySelector<HTMLButtonElement>('button[title="Remove"]')!.click(); fixture.detectChanges();
    expect(composer.draft()).toBe(' and');
    expect(removed).toHaveBeenCalledExactlyOnceWith(file.id);
    expect(composer.attachments()).toEqual([]);
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(composer.draft()).toBe(' and');
    expect(surface.querySelector('ex-element-chip')).toBeNull();
  });
  it('deletes one atomic mention, retains its attachment below the writing line, and supports undo/redo', () => {
    const { fixture, composer, editor, surface } = mount([file]);
    composer.draft.set('Make ❶ wider'); fixture.detectChanges();
    editor.setSelection({ start: 6, end: 6 });
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(composer.draft()).toBe('Make  wider');
    expect(surface.querySelector('ex-element-chip')).toBeNull();
    expect(fixture.nativeElement.querySelector('.staged-elements ex-element-chip')).not.toBeNull();
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(composer.draft()).toBe('Make ❶ wider');
    expect(surface.querySelectorAll('ex-element-chip')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.staged-elements')).toBeNull();
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(composer.draft()).toBe('Make  wider');
  });
  it('shows the placeholder only while the draft is empty, including plain text beside unreferenced elements', () => {
    const { fixture, composer, surface } = mount([file]);
    composer.draft.set(''); fixture.detectChanges();
    expect(surface.classList).toContain('empty');
    composer.draft.set('Make it wider.'); fixture.detectChanges();
    expect(surface.querySelector('ex-element-chip')).toBeNull();
    expect(surface.classList).not.toContain('empty');
    composer.draft.set(''); fixture.detectChanges();
    surface.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(surface.classList).not.toContain('empty');
  });
  it('updates inline progress without replacing the writing DOM or chip controls', () => {
    const { fixture, composer, surface } = mount([file]);
    composer.draft.set('Make ❶ wider'); fixture.detectChanges();
    const text = surface.firstChild, face = surface.querySelector('.face');
    fixture.componentRef.setInput('attachments', [{ ...file, status: 'uploading', progress: 42 }]); fixture.detectChanges();
    expect(surface.firstChild).toBe(text);
    expect(surface.querySelector('.face')).toBe(face);
    expect(surface.querySelector('.progress')).not.toBeNull();
    expect(composer.canSend()).toBe(false);
  });
  it('pastes only plain text, preserving a selected known reference and rejecting HTML markup', () => {
    const { fixture, composer, editor, surface } = mount([file]);
    composer.draft.set('Align ❶'); fixture.detectChanges();
    editor.setSelection({ start: 0, end: composer.draft().length });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? 'Make @“Save” <img src=x onerror=alert(1)>' : '<img src=x onerror=alert(1)>' } });
    surface.dispatchEvent(event); fixture.detectChanges();
    expect(composer.draft()).toBe('Make ❶ <img src=x onerror=alert(1)>');
    expect(surface.querySelectorAll('ex-element-chip')).toHaveLength(1);
    expect(surface.querySelector('img')).toBeNull();
    expect(surface.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('leaves composition in the browser until it ends and keeps ordinary typing beside a chip', () => {
    const { fixture, composer, surface } = mount([file]);
    composer.draft.set('Name ❶'); fixture.detectChanges();
    const text = surface.firstChild!;
    surface.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    text.textContent = '名前 ';
    surface.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' })); fixture.detectChanges();
    expect(composer.draft()).toBe('Name ❶');
    expect(surface.firstChild).toBe(text);
    surface.dispatchEvent(new Event('compositionend', { bubbles: true }));
    fixture.detectChanges();
    expect(composer.draft()).toBe('名前 ❶');
    expect(surface.querySelectorAll('ex-element-chip')).toHaveLength(1);
  });
  it('does not submit when Enter activates an inline chip control, and clears stale undo on a new draft', () => {
    const { fixture, composer, editor, surface } = mount([file]);
    editor.replace(0, 0, 'Make ❶ wider'); fixture.detectChanges();
    const sent = vi.fn(); composer.submitted.subscribe(sent);
    surface.querySelector('.face')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(sent).not.toHaveBeenCalled();
    composer.draft.set('A different draft'); fixture.detectChanges();
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(composer.draft()).toBe('A different draft');
  });
});

describe('editor handoff and cancellation', () => {
  it('transfers the native caret when the first element arrives', async () => {
    const fixture = TestBed.createComponent(ComposerComponent);
    fixture.componentRef.setInput('elementPickAvailable', true); fixture.detectChanges();
    const composer = fixture.componentInstance;
    composer.draft.set('Alignwith the heading'); fixture.detectChanges();
    const textarea = composer.textarea()!.nativeElement;
    textarea.focus(); textarea.setSelectionRange(5, 5);
    composer.insertElement(1);
    fixture.componentRef.setInput('attachments', [file]); fixture.detectChanges();
    await fixture.whenStable(); fixture.detectChanges();
    expect(composer.draft()).toBe('Align ❶ with the heading');
    expect(composer.elementEditor()!.selection().start).toBe(8);
    expect(fixture.nativeElement.querySelector('textarea')).toBeNull();
  });
  it('discards unfinished composition when an external draft replaces it', () => {
    const { fixture, composer, surface } = mount([file]);
    composer.draft.set('Old ❶'); fixture.detectChanges();
    surface.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    surface.firstChild!.textContent = '未確定 ';
    composer.draft.set('New draft'); fixture.detectChanges();
    surface.dispatchEvent(new Event('compositionend', { bubbles: true })); fixture.detectChanges();
    expect(composer.draft()).toBe('New draft');
    expect(editorText(surface)).toBe('New draft');
  });
});

it('does not resurrect a removed attachment through undo after erasing its reference', () => {
  const { fixture, composer, editor, surface } = mount([file]);
  editor.replace(0, 0, 'Make ❶ wider'); fixture.detectChanges();
  editor.replace(5, 6, ''); fixture.detectChanges();
  composer.removeElement(file); fixture.componentRef.setInput('attachments', []); fixture.detectChanges();
  surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
  expect(composer.draft()).toBe('Make  wider');
  expect(surface.querySelector('ex-element-chip')).toBeNull();
});
