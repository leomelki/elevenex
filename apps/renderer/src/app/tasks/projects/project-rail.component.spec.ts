import { TestBed } from '@angular/core/testing';
import { ProjectRailComponent } from './project-rail.component';

it('returns the actual add tile for the modal origin and selects supplied project identities', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
  try {
    const fixture = TestBed.createComponent(ProjectRailComponent);
    fixture.componentRef.setInput('projects', [{ id: 'checkout', name: 'Checkout' }]);
    fixture.componentRef.setInput('activeId', 'checkout'); fixture.detectChanges();
    const add = vi.fn(); fixture.componentInstance.addProject.subscribe(add);
    const tile = fixture.nativeElement.querySelector('.add') as HTMLButtonElement;
    tile.click(); expect(add).toHaveBeenCalledExactlyOnceWith(tile);
    const first = fixture.nativeElement.querySelector('[data-project-id="checkout"]');
    fixture.componentRef.setInput('projects', [{ id: 'checkout', name: 'Checkout' }, { id: 'payments', name: 'Payments' }]);
    fixture.componentRef.setInput('activeId', 'payments'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-project-id="checkout"]')).toBe(first);
    expect(fixture.nativeElement.querySelector('[aria-current="true"]').getAttribute('data-project-id')).toBe('payments');
  } finally { TestBed.resetTestingModule(); vi.unstubAllGlobals(); }
});
