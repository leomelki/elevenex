import {
  Directive,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import type { DictationTarget } from './dictation.service';
import { DictationService } from './dictation.service';

let nextId = 0;

/**
 * Makes any `<textarea>` dictatable.
 *
 * The composers in this app bind their textareas five different ways
 * (`[ngModel]` one-way plus `(input)`, `[value]` plus `(input)`, `[ngModel]`
 * with `(ngModelChange)`, and the Zard `z-input` control-value accessor). This
 * directive writes to the DOM node and dispatches a native `input` event, which
 * every one of those bindings already listens to — so a composer gains
 * dictation without a single line of composer-specific wiring.
 */
@Directive({
  selector: 'textarea[appDictateTarget]',
  standalone: true,
  exportAs: 'dictateTarget',
  host: {
    '(keydown)': 'onKeydown($event)',
  },
})
export class DictateTargetDirective implements DictationTarget {
  private readonly elementRef =
    inject<ElementRef<HTMLTextAreaElement>>(ElementRef);
  private readonly dictation = inject(DictationService);

  /** Session context, so transcription can bias towards this repo's names. */
  readonly sessionId = input<number | null>(null);
  readonly worktreePath = input<string | null>(null);

  /**
   * Emitted after a transcript is inserted, when the auto-send setting is on.
   * Composers wire this to whatever "send" means for them.
   */
  readonly dictationSubmit = output<void>();

  readonly dictationId = `dictate-${(nextId += 1)}`;

  /** Range of the last insertion, used to swap in the cleaned-up text. */
  private lastInsertion: { start: number; end: number; text: string } | null =
    null;

  get dictationSessionId(): number | null {
    return this.sessionId();
  }

  get dictationWorktreePath(): string | null {
    return this.worktreePath();
  }

  canDictate(): boolean {
    const element = this.elementRef.nativeElement;
    return element.isConnected && !element.disabled && !element.readOnly;
  }

  focusTarget(): void {
    this.elementRef.nativeElement.focus();
  }

  submitTarget(): void {
    this.dictationSubmit.emit();
  }

  /**
   * Inserts at the caret, replacing any selection. Uses `setRangeText` so the
   * insertion joins the browser's native undo stack — Ctrl+Z removes the
   * dictated words rather than nothing.
   */
  insertDictation(text: string): void {
    const element = this.elementRef.nativeElement;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const spaced = this.padForInsertion(element.value, start, end, text);

    element.focus();
    element.setRangeText(spaced, start, end, 'end');
    this.lastInsertion = {
      start,
      end: start + spaced.length,
      text: spaced,
    };
    this.notify();
  }

  /**
   * Swaps the last insertion for its cleaned-up version. Returns false — and
   * changes nothing — if the user has typed over it in the meantime, so a slow
   * cleanup model can never clobber an edit.
   */
  replaceDictation(text: string): boolean {
    const element = this.elementRef.nativeElement;
    const insertion = this.lastInsertion;
    if (!insertion) {
      return false;
    }

    const current = element.value.slice(insertion.start, insertion.end);
    if (current !== insertion.text) {
      this.lastInsertion = null;
      return false;
    }

    const spaced = this.preserveEdges(insertion.text, text);
    const caretWasAtEnd = element.selectionStart === insertion.end;

    element.setRangeText(spaced, insertion.start, insertion.end, 'preserve');
    this.lastInsertion = {
      start: insertion.start,
      end: insertion.start + spaced.length,
      text: spaced,
    };
    if (caretWasAtEnd) {
      const caret = insertion.start + spaced.length;
      element.setSelectionRange(caret, caret);
    }
    this.notify();
    return true;
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Esc cancels an in-flight recording. Stop propagation so it does not also
    // close the command bar or dialog the textarea lives in.
    if (event.key === 'Escape' && this.dictation.isActive(this.dictationId)) {
      event.preventDefault();
      event.stopPropagation();
      this.dictation.cancel();
      return;
    }

    // Ctrl/Cmd+Shift+M toggles dictation for the focused textarea. Bound here
    // rather than on `document` so it cannot fight another component's keys.
    const isToggle =
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      !event.altKey &&
      (event.key === 'm' || event.key === 'M');
    if (isToggle) {
      event.preventDefault();
      event.stopPropagation();
      void this.dictation.toggle(this);
    }
  }

  /**
   * Speech has no spaces around it, so inserting mid-sentence would otherwise
   * produce "fixthe composer". Only adds separators that are actually missing.
   */
  private padForInsertion(
    value: string,
    start: number,
    end: number,
    text: string,
  ): string {
    const before = value.slice(0, start);
    const after = value.slice(end);
    const needsLeading = before.length > 0 && !/\s$/.test(before);
    const needsTrailing = after.length > 0 && !/^\s/.test(after);
    return `${needsLeading ? ' ' : ''}${text}${needsTrailing ? ' ' : ''}`;
  }

  /** Keeps the padding computed at insertion time when swapping the text. */
  private preserveEdges(original: string, replacement: string): string {
    const leading = /^\s*/.exec(original)?.[0] ?? '';
    const trailing = /\s*$/.exec(original)?.[0] ?? '';
    return `${leading}${replacement.trim()}${trailing}`;
  }

  /**
   * A native, bubbling `input` event. This is what makes the directive
   * binding-agnostic: Angular's default value accessor, `ngModel`, the Zard
   * `z-input` CVA and hand-rolled `(input)` handlers all listen for it.
   */
  private notify(): void {
    this.elementRef.nativeElement.dispatchEvent(
      new Event('input', { bubbles: true }),
    );
  }
}
