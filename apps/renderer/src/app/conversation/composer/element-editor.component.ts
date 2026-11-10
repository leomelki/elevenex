import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, ViewContainerRef,
  inject, input, output, viewChild, type AfterViewInit, type ComponentRef, type OnChanges,
} from '@angular/core';
import { elementMarker, elementMarkersIn, type BrowserElementReference } from '@elevenex/shared';
import type { ConversationAttachment } from '../conversation.models';
import { ElementChipComponent } from '../element/element-chip.component';
import { displayElementMentions, elementMentionNames, encodeElementMentions } from '../element/element-mention-text';
import { editorSelection, editorText, selectEditor, type EditorSelection } from './element-editor-dom';

interface EditorState extends EditorSelection { readonly text: string }

/** Owns the editable DOM and atomic chip views. The composer owns draft and attachment lifetimes. */
@Component({
  selector: 'ex-element-editor',
  templateUrl: './element-editor.component.html',
  styleUrl: './element-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementEditorComponent implements OnChanges, AfterViewInit {
  readonly value = input('');
  readonly files = input<readonly ConversationAttachment[]>([]);
  readonly disabled = input(false);
  readonly sending = input(false);
  readonly pickAvailable = input(false);
  readonly placeholder = input('');
  readonly controls = input<string | null>(null);
  readonly activeOption = input<string | null>(null);
  readonly initialSelection = input<EditorSelection>();
  readonly autofocus = input(false);
  readonly changed = output<EditorState>();
  readonly keyed = output<KeyboardEvent>();
  readonly removed = output<string>();
  readonly retry = output<string>();
  readonly repick = output<BrowserElementReference>();
  readonly mention = output<number>();
  readonly surface = viewChild<ElementRef<HTMLDivElement>>('surface');
  private readonly views = viewChild('tokens', { read: ViewContainerRef });
  private readonly chips = new Map<string, ComponentRef<ElementChipComponent>>();
  private current: EditorState = { text: '', start: 0, end: 0 };
  private readonly past: EditorState[] = [];
  private readonly future: EditorState[] = [];
  private composing = false;
  private cancelledComposition = false;
  private lastEdit = { type: '', at: 0, caret: 0 };
  private renderedText: string | null = null;
  private knownFiles = new Set<string>();

  constructor() {
    // ViewContainerRef owns teardown of the dynamic chip views with this editor.
    inject(DestroyRef).onDestroy(() => this.chips.clear());
  }
  ngAfterViewInit(): void {
    const selection = this.initialSelection() ?? { start: this.value().length, end: this.value().length };
    this.current = { text: this.value(), ...selection };
    this.knownFiles = new Set(this.files().map(file => file.id));
    this.render();
    if (this.autofocus()) this.focus();
  }
  ngOnChanges(): void {
    if (!this.surface()) return;
    const files = new Set(this.files().map(file => file.id));
    const removed = [...this.knownFiles].some(id => !files.has(id));
    this.knownFiles = files;
    if (this.composing && this.value() === this.current.text && !removed) return;
    if (this.value() !== this.current.text || removed) {
      // A different session/draft or an explicit attachment removal starts a new history.
      if (this.composing) {
        this.cancelledComposition = true; this.composing = false;
        this.surface()!.nativeElement.blur();
      }
      this.past.length = 0; this.future.length = 0;
      this.current = { text: this.value(), start: Math.min(this.current.start, this.value().length), end: Math.min(this.current.end, this.value().length) };
      this.lastEdit = { type: '', at: 0, caret: this.current.end };
    }
    this.render();
  }
  focus(): void {
    if (this.disabled()) return;
    const root = this.surface()?.nativeElement;
    if (root) { root.focus({ preventScroll: true }); selectEditor(root, this.current); }
  }
  selection(): EditorSelection {
    this.remember();
    return { start: this.current.start, end: this.current.end };
  }
  setSelection(selection: EditorSelection): void {
    this.current = { ...this.current, ...selection };
    const root = this.surface()?.nativeElement;
    if (root) selectEditor(root, selection);
  }
  remember(): void {
    const root = this.surface()?.nativeElement;
    const selection = root ? editorSelection(root) : null;
    if (selection) this.current = { ...this.current, ...selection };
  }
  replace(start: number, end: number, text: string): void {
    if (this.disabled()) return;
    const next = this.current.text.slice(0, start) + text + this.current.text.slice(end);
    this.commit({ text: next, start: start + text.length, end: start + text.length }, 'replace');
    this.render(); this.focus();
  }
  beforeInput(event: Event): void {
    if (!(event instanceof InputEvent)) return;
    if (this.disabled()) { event.preventDefault(); return; }
    if (event.inputType.startsWith('format')) { event.preventDefault(); return; }
    if (this.cancelledComposition && event.isComposing) { event.preventDefault(); return; }
    this.cancelledComposition = false;
    this.remember();
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault(); this.history(event.inputType === 'historyRedo');
    } else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault(); this.replace(this.current.start, this.current.end, '\n');
    }
  }
  input(event: Event): void {
    if (this.disabled() || this.composing || this.cancelledComposition || (event instanceof InputEvent && event.isComposing)) return;
    const root = this.surface()!.nativeElement;
    const selection = editorSelection(root) ?? { start: this.current.start, end: this.current.end };
    this.commit({ text: editorText(root), ...selection }, event instanceof InputEvent ? event.inputType : 'input');
    this.render();
  }
  composition(active: boolean): void {
    // Composed characters are not committed until compositionend; hide the placeholder meanwhile.
    if (active) { this.cancelledComposition = false; this.surface()?.nativeElement.classList.remove('empty'); }
    else if (this.cancelledComposition) return;
    this.composing = active;
    if (!active) this.input(new Event('input'));
  }
  key(event: KeyboardEvent): void {
    if (event.target !== this.surface()?.nativeElement || this.composing || event.isComposing) return;
    this.remember();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); this.history(event.shiftKey || event.key.toLowerCase() === 'y'); return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault(); this.replace(this.current.start, this.current.end, '\n'); return;
    }
    if (this.current.start === this.current.end && ['Backspace', 'Delete'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const start = this.current.start - (event.key === 'Backspace' ? 1 : 0);
      if (elementMarkersIn(this.current.text.slice(start, start + 1)).length) {
        event.preventDefault(); this.replace(start, start + 1, ''); return;
      }
    }
    this.keyed.emit(event);
  }
  clipboard(event: ClipboardEvent, cut = false): void {
    this.remember();
    if (!event.clipboardData || this.current.start === this.current.end) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', displayElementMentions(this.current.text.slice(this.current.start, this.current.end), elementMentionNames(this.files())));
    if (cut) this.replace(this.current.start, this.current.end, '');
  }
  paste(event: ClipboardEvent): void {
    if (!event.clipboardData || event.clipboardData.files.length) return;
    event.preventDefault(); this.remember();
    this.replace(this.current.start, this.current.end, encodeElementMentions(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'), elementMentionNames(this.files())));
  }
  drop(event: DragEvent): void {
    if (event.dataTransfer?.types.some(type => type !== 'text/plain' && type !== 'text/html')) return;
    event.preventDefault();
    const text = event.dataTransfer?.getData('text/plain');
    if (text) { this.remember(); this.replace(this.current.start, this.current.end, text); }
  }
  private removeMention(host: HTMLElement, id: string): void {
    const root = this.surface()?.nativeElement;
    if (this.disabled() || this.sending() || host.parentNode !== root) return;
    // Resolve the clicked occurrence from the current DOM; its offset changes as
    // prose is edited, and every occurrence shares the same attachment ID.
    let start = 0;
    for (let node = host.previousSibling; node; node = node.previousSibling) start += editorText(node).length;
    const glyph = editorText(host);
    const remaining = this.current.text.slice(0, start) + this.current.text.slice(start + glyph.length);
    if (remaining.includes(glyph)) {
      this.remember();
      this.replace(start, start + glyph.length, '');
    } else {
      // Explicitly removing the final reference also releases its snapshot.
      this.removed.emit(id);
    }
  }
  private commit(next: EditorState, type: string): void {
    if (next.text === this.current.text) { this.current = next; return; }
    const at = performance.now();
    const grouped = ['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(type) && type === this.lastEdit.type && at - this.lastEdit.at < 750 && this.current.start === this.current.end && this.current.start === this.lastEdit.caret && !elementMarkersIn(this.current.text).some(marker => !next.text.includes(elementMarker(marker)));
    if (!grouped) { this.past.push(this.current); if (this.past.length > 100) this.past.shift(); }
    this.future.length = 0;
    this.lastEdit = { type, at, caret: next.end };
    this.current = next;
    this.changed.emit(next);
  }
  private history(redo: boolean): void {
    if (this.disabled()) return;
    this.remember();
    const next = (redo ? this.future : this.past).pop();
    if (!next) return;
    (redo ? this.past : this.future).push(this.current);
    this.current = next; this.lastEdit = { type: '', at: 0, caret: next.end };
    this.changed.emit(next); this.render(); this.focus();
  }
  private render(): void {
    if (this.composing) return;
    const root = this.surface()!.nativeElement;
    root.classList.toggle('empty', !this.current.text);
    const focused = root.ownerDocument.activeElement === root;
    const files = new Map(this.files().map(file => [file.marker, file]));
    const update = (ref: ComponentRef<ElementChipComponent>, file: ConversationAttachment) => {
      ref.setInput('file', file); ref.setInput('inline', true); ref.setInput('editing', true);
      ref.setInput('disabled', this.disabled() || this.sending()); ref.setInput('pickAvailable', this.pickAvailable());
      ref.changeDetectorRef.detectChanges();
    };
    const hosts = new Set<HTMLElement>([...this.chips.values()].map(ref => ref.location.nativeElement));
    const flat = [...root.childNodes].every(node => node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && (node.dataset['editorTail'] || hosts.has(node))));
    // Upload/progress and configuration updates must retain the writing DOM,
    // native selection and focused chip buttons, including open CDK popovers.
    if (flat && this.renderedText === this.current.text && editorText(root) === this.current.text && [...this.chips.values()].every(ref => files.get(ref.instance.file().marker)?.id === ref.instance.file().id)) {
      for (const ref of this.chips.values()) {
        const file = files.get(ref.instance.file().marker);
        if (file) update(ref, file);
      }
      return;
    }
    const counts = new Map<number, number>();
    const used = new Set<string>();
    const fragment = root.ownerDocument.createDocumentFragment();
    let run = '';
    const flush = () => { if (run) { fragment.append(root.ownerDocument.createTextNode(run)); run = ''; } };
    for (const char of this.current.text) {
      const marker = elementMarkersIn(char)[0];
      const file = marker ? files.get(marker) : undefined;
      if (!file || !marker) { run += char; continue; }
      flush();
      const occurrence = counts.get(marker) ?? 0; counts.set(marker, occurrence + 1);
      const key = `${file.id}:${occurrence}`; used.add(key);
      let ref = this.chips.get(key);
      if (!ref) {
        ref = this.views()!.createComponent(ElementChipComponent);
        const host: HTMLElement = ref.location.nativeElement;
        host.setAttribute('contenteditable', 'false'); host.dataset['editorMarker'] = String(marker);
        ref.instance.removed.subscribe(id => this.removeMention(host, id));
        ref.instance.retry.subscribe(id => this.retry.emit(id));
        ref.instance.repick.subscribe(reference => this.repick.emit(reference));
        ref.instance.mention.subscribe(() => this.mention.emit(marker));
        this.chips.set(key, ref);
      }
      // Keep the existing CDK popover and focus ownership on each real chip.
      update(ref, file);
      fragment.append(ref.location.nativeElement);
    }
    flush();
    const tail = root.ownerDocument.createElement('br'); tail.dataset['editorTail'] = 'true'; fragment.append(tail);
    for (const [key, ref] of this.chips) {
      if (!used.has(key)) { const index = this.views()!.indexOf(ref.hostView); if (index >= 0) this.views()!.remove(index); this.chips.delete(key); }
    }
    root.replaceChildren(fragment);
    this.renderedText = this.current.text;
    if (focused) selectEditor(root, this.current);
  }
}
