import { TestBed } from '@angular/core/testing';
import { BranchPickerComponent } from './branch-picker.component';

describe('branch picker search labels', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined })));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['develop', 'de', ['de']],
    ['develop', 'vel', ['vel']],
    ['develop', 'op', ['op']],
    ['develop', 'develop', ['develop']],
    ['develop', '', []],
    ['feature/refund-rate', 'refund rate', ['refund', 'rate']],
    ['release/v1.2', 'v1.2', ['v1.2']],
    ['Feature/Refund', 'feature refund', ['Feature', 'Refund']],
  ])('preserves the exact branch %s when searching for %s', (name, query, matches) => {
    const fixture = TestBed.createComponent(BranchPickerComponent);
    fixture.componentRef.setInput('branches', [{ name }]);
    fixture.componentRef.setInput('query', query);
    fixture.detectChanges();

    const label = fixture.nativeElement.querySelector('[role="option"] .mono') as HTMLElement;
    expect(label.textContent).toBe(name);
    expect(Array.from(label.querySelectorAll('mark'), mark => mark.textContent)).toEqual(matches);
    const picked = vi.fn(); fixture.componentInstance.pick.subscribe(picked);
    (label.closest('button') as HTMLButtonElement).click();
    expect(picked).toHaveBeenCalledExactlyOnceWith({ name, kind: 'branch' });
  });

  it('preserves names in create and unavailable branch rows too', () => {
    const fixture = TestBed.createComponent(BranchPickerComponent);
    fixture.componentRef.setInput('items', [
      { name: 'feature/refund', kind: 'create' },
      { name: 'feature/refund-fix', kind: 'branch', task: 'Refund task' },
    ]);
    fixture.componentRef.setInput('query', 'refund');
    fixture.detectChanges();

    const labels = fixture.nativeElement.querySelectorAll('[role="option"] .mono') as NodeListOf<HTMLElement>;
    expect(Array.from(labels, label => label.textContent)).toEqual(['feature/refund', 'feature/refund-fix']);
    expect((labels[1]!.closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
