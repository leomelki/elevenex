import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { DictateTargetDirective } from './dictate-target.directive';

@Component({
  standalone: true,
  imports: [DictateTargetDirective],
  template: `
    <textarea
      appDictateTarget
      #dictate="dictateTarget"
      [value]="value()"
      (input)="value.set($any($event.target).value)"
    ></textarea>
  `,
})
class HostComponent {
  readonly value = signal('');
  readonly dictate = viewChild.required(DictateTargetDirective);
}

describe('DictateTargetDirective', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>;
  let textarea: HTMLTextAreaElement;
  let directive: DictateTargetDirective;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    textarea = fixture.nativeElement.querySelector('textarea');
    directive = fixture.componentInstance.dictate();
  });

  function setValue(value: string, caret = value.length): void {
    textarea.value = value;
    textarea.setSelectionRange(caret, caret);
  }

  describe('insertDictation', () => {
    it('inserts into an empty textarea without padding', () => {
      directive.insertDictation('fix the composer');
      expect(textarea.value).toBe('fix the composer');
    });

    it('inserts at the caret rather than appending', () => {
      setValue('start  end', 6);
      directive.insertDictation('middle');
      expect(textarea.value).toBe('start middle end');
    });

    it('adds a separating space when the caret follows a word', () => {
      setValue('fix', 3);
      directive.insertDictation('the composer');
      expect(textarea.value).toBe('fix the composer');
    });

    it('does not double a space that is already there', () => {
      setValue('fix ', 4);
      directive.insertDictation('the composer');
      expect(textarea.value).toBe('fix the composer');
    });

    it('adds a trailing space when inserting before existing text', () => {
      setValue('the composer', 0);
      directive.insertDictation('fix');
      expect(textarea.value).toBe('fix the composer');
    });

    it('replaces the current selection', () => {
      textarea.value = 'fix the parser';
      textarea.setSelectionRange(8, 14);
      directive.insertDictation('composer');
      expect(textarea.value).toBe('fix the composer');
    });

    it('dispatches a native input event so any binding style updates', () => {
      // This is what lets one directive serve five differently-bound composers.
      directive.insertDictation('hello');
      expect(fixture.componentInstance.value()).toBe('hello');
    });

    it('leaves the caret after the inserted text', () => {
      setValue('start  end', 6);
      directive.insertDictation('middle');
      expect(textarea.selectionStart).toBe('start middle'.length);
    });
  });

  describe('replaceDictation', () => {
    it('swaps the inserted text for its cleaned-up version', () => {
      setValue('fix ', 4);
      directive.insertDictation('the cw dash composer');
      expect(directive.replaceDictation('the cw-composer')).toBe(true);
      expect(textarea.value).toBe('fix the cw-composer');
    });

    it('keeps surrounding text untouched', () => {
      setValue('before  after', 7);
      directive.insertDictation('um the thing');
      directive.replaceDictation('the thing');
      expect(textarea.value).toBe('before the thing after');
    });

    it('refuses to replace once the user has edited the insertion', () => {
      setValue('', 0);
      directive.insertDictation('um the thing');
      // Simulate the user editing what was dictated while cleanup was in flight.
      textarea.value = 'completely different';

      expect(directive.replaceDictation('the thing')).toBe(false);
      expect(textarea.value).toBe('completely different');
    });

    it('returns false when nothing has been dictated yet', () => {
      expect(directive.replaceDictation('anything')).toBe(false);
    });

    it('does not apply a second replacement after a rejected one', () => {
      directive.insertDictation('first');
      textarea.value = 'edited';
      expect(directive.replaceDictation('cleaned')).toBe(false);
      expect(directive.replaceDictation('cleaned again')).toBe(false);
      expect(textarea.value).toBe('edited');
    });

    it('notifies bindings of the replacement', () => {
      directive.insertDictation('um hello');
      directive.replaceDictation('hello');
      expect(fixture.componentInstance.value()).toBe('hello');
    });
  });

  describe('canDictate', () => {
    it('is false while the textarea is disabled', () => {
      textarea.disabled = true;
      expect(directive.canDictate()).toBe(false);
    });

    it('is false once the element is detached', () => {
      textarea.remove();
      expect(directive.canDictate()).toBe(false);
    });

    it('is true for a live, editable textarea', () => {
      expect(directive.canDictate()).toBe(true);
    });
  });
});
