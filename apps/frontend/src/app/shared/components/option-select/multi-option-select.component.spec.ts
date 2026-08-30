import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { describe, expect, it, beforeEach } from 'vitest';
import { MultiOptionSelectComponent } from './multi-option-select.component';
import type { OptionSelectItem } from './option-select.component';

const OPTIONS: OptionSelectItem[] = [
  { value: 'fr', label: 'French' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
];

@Component({
  imports: [MultiOptionSelectComponent],
  template: `
    <app-multi-option-select
      ariaLabel="Languages"
      placeholder="Detect automatically"
      primaryBadge="Fallback"
      [options]="options"
      [values]="values()"
      [max]="max()"
      (valuesChange)="values.set($event)"
    />
  `,
})
class HostComponent {
  readonly options = OPTIONS;
  readonly values = signal<string[]>([]);
  readonly max = signal(0);
}

describe('MultiOptionSelectComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    await fixture.whenStable();
  });

  function trigger(): HTMLButtonElement {
    return fixture.nativeElement.querySelector(
      'button[role="combobox"]',
    ) as HTMLButtonElement;
  }

  function optionButtons(): HTMLButtonElement[] {
    // The panel renders in a CDK overlay, outside the fixture's own element.
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
    );
  }

  async function openPanel(): Promise<void> {
    trigger().click();
    await fixture.whenStable();
  }

  it('shows the placeholder until something is selected', async () => {
    expect(trigger().textContent).toContain('Detect automatically');

    host.values.set(['fr']);
    await fixture.whenStable();

    expect(trigger().textContent).toContain('French');
  });

  it('lists every selection in the order it was made', async () => {
    host.values.set(['fr', 'en']);
    await fixture.whenStable();

    // Not "English, French": the first entry is the fallback, so the order the
    // user chose has to survive into the label.
    expect(trigger().textContent?.replace(/\s+/g, ' ')).toContain(
      'French, English',
    );
  });

  it('appends a newly picked option rather than reordering', async () => {
    host.values.set(['en']);
    await fixture.whenStable();
    await openPanel();

    optionButtons()[0]!.click();
    await fixture.whenStable();

    expect(host.values()).toEqual(['en', 'fr']);
  });

  it('removes an option that is picked again', async () => {
    host.values.set(['fr', 'en']);
    await fixture.whenStable();
    await openPanel();

    optionButtons()[0]!.click();
    await fixture.whenStable();

    expect(host.values()).toEqual(['en']);
  });

  it('keeps the panel open across several picks', async () => {
    await openPanel();

    optionButtons()[0]!.click();
    await fixture.whenStable();
    optionButtons()[1]!.click();
    await fixture.whenStable();

    // Reopening the list for each language would make picking three a chore.
    expect(host.values()).toEqual(['fr', 'en']);
    expect(optionButtons()).not.toHaveLength(0);
  });

  it('blocks further picks at the cap but still allows removals', async () => {
    host.max.set(2);
    host.values.set(['fr', 'en']);
    await fixture.whenStable();
    await openPanel();

    const [french, , german] = optionButtons();
    expect(german!.disabled).toBe(true);
    expect(french!.disabled).toBe(false);

    french!.click();
    await fixture.whenStable();
    expect(host.values()).toEqual(['en']);
  });

  it('marks only the first selection as the fallback', async () => {
    host.values.set(['fr', 'en']);
    await fixture.whenStable();
    await openPanel();

    const [french, english] = optionButtons();
    expect(french!.textContent).toContain('Fallback');
    expect(english!.textContent).not.toContain('Fallback');
  });

  it('reports its multi-select nature to assistive technology', async () => {
    host.values.set(['fr']);
    await fixture.whenStable();
    await openPanel();

    const list = document.querySelector('[role="listbox"]');
    expect(list?.getAttribute('aria-multiselectable')).toBe('true');
    expect(optionButtons()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(optionButtons()[1]?.getAttribute('aria-selected')).toBe('false');
  });
});
