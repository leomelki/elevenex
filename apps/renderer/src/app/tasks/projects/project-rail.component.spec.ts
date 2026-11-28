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

it('keeps a project mark entering through activity changes and subsequent additions', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  const animate = vi.fn(function (this: Element) {
    return { cancel: vi.fn(), finished: new Promise<void>(() => undefined) };
  });
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
  try {
    const fixture = TestBed.createComponent(ProjectRailComponent);
    const checkout = { id: 'checkout', name: 'Checkout' };
    const payments = { id: 'payments', name: 'Payments', attention: 1 };
    fixture.componentRef.setInput('projects', [checkout]);
    fixture.detectChanges();
    fixture.componentRef.setInput('projects', [checkout, payments]);
    fixture.detectChanges();
    const mark = fixture.nativeElement.querySelector('[data-project-id="payments"] ex-project-mark');
    const pip = fixture.nativeElement.querySelector('[data-project-id="payments"] .pip');
    expect(pip).not.toBeNull();
    const call = animate.mock.contexts.indexOf(mark);
    expect(call).toBeGreaterThanOrEqual(0);
    const animation = animate.mock.results[call]!.value;
    fixture.componentRef.setInput('projects', [{ ...checkout, attention: 2 }, { ...payments, attention: 2 }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-project-id="payments"] .pip')).toBe(pip);
    fixture.componentRef.setInput('projects', [checkout, payments, { id: 'shipping', name: 'Shipping' }]);
    fixture.detectChanges();
    expect(animation.cancel).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-project-id="payments"] ex-project-mark')).toBe(mark);
    fixture.componentRef.setInput('projects', [checkout]);
    fixture.detectChanges();
    expect(animation.cancel).toHaveBeenCalledTimes(1);
  } finally {
    TestBed.resetTestingModule(); vi.unstubAllGlobals();
    if (descriptor) Object.defineProperty(Element.prototype, 'animate', descriptor);
    else Reflect.deleteProperty(Element.prototype, 'animate');
  }
});
