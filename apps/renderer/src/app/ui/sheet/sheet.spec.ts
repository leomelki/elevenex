import { A11yModule } from '@angular/cdk/a11y';
import { Component, ElementRef, afterRenderEffect, input, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalLayerComponent } from './modal-layer.component';
import { ModalMotion } from './modal-motion';
import { ModalRecessionService } from './modal-recession.service';
import { SetValueComponent } from './settings-controls.component';
import { SheetComponent } from './sheet.component';
import { SheetSectionDirective } from './sheet-section.directive';

@Component({ imports: [ModalLayerComponent, A11yModule], template: `
  <div data-modal-window><div class="ex-shell"><button id="return">Settings</button></div>
    <ex-modal-layer [open]="sheet()" (closeRequested)="sheet.set(false)"><section role="dialog" aria-label="Settings"><button cdkFocusInitial id="confirm">Delete</button></section></ex-modal-layer>
    <ex-modal-layer [open]="confirm()" (closeRequested)="confirm.set(false)"><section role="alertdialog" aria-label="Delete"><button cdkFocusInitial id="cancel">Cancel</button></section></ex-modal-layer>
  </div>
` })
class LayersHost {
  readonly sheet = signal(false);
  readonly confirm = signal(false);
}

@Component({ imports: [SheetComponent, SheetSectionDirective], template: `
  <ex-sheet [open]="true" section="one"><ng-template exSheetSection="one" label="One"><p>First setting</p></ng-template><ng-template exSheetSection="two" label="Two"><p>Second setting</p></ng-template></ex-sheet>
` })
class SectionsHost {}

@Component({ selector: 'ex-autofocus-child', template: '<input #field aria-label="Project name" />' })
class AutofocusedChild {
  readonly active = input(false);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  constructor() {
    afterRenderEffect(() => {
      const field = this.field()?.nativeElement;
      if (this.active() && field?.isConnected) field.focus();
    });
  }
}

@Component({ imports: [ModalLayerComponent, AutofocusedChild], template: `
  <button id="autofocus-opener">New project</button>
  <ex-modal-layer [open]="open()"><section role="dialog" aria-label="New project"><ng-container><ex-autofocus-child [active]="open()" /></ng-container></section></ex-modal-layer>
` })
class AutofocusHost { readonly open = signal(false); }

describe('settings surfaces', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })));
  afterEach(() => vi.unstubAllGlobals());

  it('leaves projected surface styles alone under reduced motion', () => {
    const layer = document.createElement('div'), surface = document.createElement('section'), trigger = document.createElement('button');
    surface.style.transformOrigin = '10px 20px';
    layer.append(surface); document.body.append(layer, trigger);
    const motion = new ModalMotion(layer, trigger);
    expect(surface.style.transformOrigin).toBe('10px 20px');
    expect(layer.querySelector('.ex-modal-face')).toBeNull();
    motion.dispose();
    expect(surface.style.transformOrigin).toBe('10px 20px');
    layer.remove(); trigger.remove();
  });

  it('counts nested modal owners and releases only its own recession lease', () => {
    const window = document.createElement('div'); window.setAttribute('data-modal-window', '');
    const shell = document.createElement('div'); shell.className = 'ex-shell'; window.append(shell);
    const origin = document.createElement('div'); window.append(origin); document.body.append(window);
    const recession = TestBed.inject(ModalRecessionService);
    const sheet = recession.acquire(origin);
    const confirm = recession.acquire(origin);
    expect(shell.getAttribute('data-recede')).toBe('2');
    expect(shell.hasAttribute('inert')).toBe(true);
    expect(sheet.isTop()).toBe(false);
    confirm.release(); confirm.release();
    expect(sheet.isTop()).toBe(true);
    expect(shell.classList.contains('is-receded')).toBe(true);
    expect(shell.getAttribute('data-recede')).toBe('1');
    sheet.release();
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(shell.classList.contains('is-receded')).toBe(false);
    window.remove();
  });

  it('dismisses the top confirmation with Escape and keeps the settings layer active', async () => {
    const fixture = TestBed.createComponent(LayersHost);
    fixture.detectChanges();
    fixture.componentInstance.sheet.set(true); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.confirm.set(true); fixture.detectChanges(); await fixture.whenStable();
    expect(document.querySelector('[role="dialog"][aria-label="Settings"]')?.closest('[inert]')).not.toBeNull();
    const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
    cancel.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.componentInstance.confirm()).toBe(false);
    expect(fixture.componentInstance.sheet()).toBe(true);
    expect(fixture.nativeElement.querySelector('.ex-shell').getAttribute('data-recede')).toBe('1');
    const settings = document.querySelector<HTMLElement>('[aria-label="Settings"][role="dialog"]')!;
    expect(settings.closest('[inert]')).toBeNull();
    fixture.destroy();
    expect(document.querySelector('#cancel')).toBeNull();
  });

  it('cancels a pending exit on reopening without replacing the surface or leaking its lease', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
    const fixture = TestBed.createComponent(LayersHost); fixture.detectChanges();
    fixture.componentInstance.sheet.set(true); fixture.detectChanges(); await fixture.whenStable();
    const surface = document.querySelector('[role="dialog"][aria-label="Settings"]');
    fixture.componentInstance.sheet.set(false); fixture.detectChanges();
    expect(surface?.closest('[inert]')).not.toBeNull();
    surface?.querySelector<HTMLElement>('button')?.blur();
    fixture.componentInstance.sheet.set(true); fixture.detectChanges(); await fixture.whenStable();
    await new Promise(resolve => setTimeout(resolve, 240));
    expect(document.querySelector('[role="dialog"][aria-label="Settings"]')).toBe(surface);
    expect(surface?.closest('[inert]')).toBeNull();
    expect(surface?.closest('.ex-modal-layer')?.contains(document.activeElement)).toBe(true);
    const background = fixture.nativeElement.querySelector('.ex-shell') as HTMLElement;
    expect(background.getAttribute('data-recede')).toBe('1');
    fixture.destroy(); expect(background.getAttribute('data-recede')).toBe('0');
  });

  it('does not borrow an unrelated window background when a scoped window has none', () => {
    const otherWindow = document.createElement('div'); otherWindow.setAttribute('data-modal-window', '');
    const background = document.createElement('div'); background.setAttribute('data-modal-background', ''); otherWindow.append(background);
    const ownWindow = document.createElement('div'); ownWindow.setAttribute('data-modal-window', '');
    const origin = document.createElement('div'); ownWindow.append(origin); document.body.append(otherWindow, ownWindow);
    const lease = TestBed.inject(ModalRecessionService).acquire(origin);
    expect(background.hasAttribute('data-recede')).toBe(false);
    lease.release(); otherWindow.remove(); ownWindow.remove();
  });

  it('recedes a launch Home when the window has no shell, without touching the machine view', () => {
    const window = document.createElement('div'); window.setAttribute('data-modal-window', '');
    window.innerHTML = '<ex-machine-launch><div class="launch"><div class="home"></div><div class="pane"></div></div></ex-machine-launch><span></span>';
    document.body.append(window);
    const home = window.querySelector('.home')!, pane = window.querySelector('.pane')!;
    const lease = TestBed.inject(ModalRecessionService).acquire(window.querySelector('span')!);
    expect(home.classList.contains('is-receded')).toBe(true);
    expect(home.hasAttribute('inert')).toBe(true);
    expect(pane.hasAttribute('inert')).toBe(false);
    lease.release();
    expect(home.hasAttribute('inert')).toBe(false);
    window.remove();
  });

  it('restores the pre-portal opener after a child autofocuses and an exit is interrupted', async () => {
    const fixture = TestBed.createComponent(AutofocusHost); fixture.detectChanges();
    const opener = fixture.nativeElement.querySelector('button') as HTMLButtonElement; opener.focus();
    fixture.componentInstance.open.set(true); fixture.detectChanges(); await fixture.whenStable();
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    expect(document.activeElement).toBe(field);
    fixture.componentInstance.open.set(false); fixture.detectChanges();
    fixture.componentInstance.open.set(true); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(field);
    fixture.componentInstance.open.set(false); fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 0)); await fixture.whenStable();
    expect(document.activeElement).toBe(opener);
  });

  it('reverts Escape and commits Enter or blur once while preserving focus', async () => {
    const fixture = TestBed.createComponent(SetValueComponent);
    fixture.componentRef.setInput('value', 'api'); fixture.componentRef.setInput('label', 'Repository tag');
    const changed = vi.fn(); const input = vi.fn();
    fixture.componentInstance.changed.subscribe(changed); fixture.componentInstance.inputChanged.subscribe(input);
    fixture.detectChanges();
    const edit = () => {
      (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click(); fixture.detectChanges();
      const field = fixture.nativeElement.querySelector('input') as HTMLInputElement;
      field.value = 'web'; field.dispatchEvent(new Event('input')); return field;
    };
    let field = edit();
    field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); fixture.detectChanges();
    expect(changed).not.toHaveBeenCalled(); expect(input).toHaveBeenLastCalledWith('api');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('button'));
    field = edit(); field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); fixture.detectChanges();
    expect(changed).toHaveBeenCalledExactlyOnceWith('web');
    fixture.componentRef.setInput('value', 'web'); fixture.detectChanges();
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click(); fixture.detectChanges();
    field = fixture.nativeElement.querySelector('input'); field.value = 'shared'; field.dispatchEvent(new Event('input')); field.dispatchEvent(new Event('blur')); fixture.detectChanges();
    expect(changed).toHaveBeenLastCalledWith('shared'); expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps every section in one scroll and pins clicked navigation until manual scrolling', async () => {
    const fixture = TestBed.createComponent(SectionsHost); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const scroll = document.querySelector<HTMLElement>('.sheet .scroll')!;
    // The projected sheet is portaled; section contents stay searchable while navigation changes.
    expect(scroll.textContent).toContain('First setting'); expect(scroll.textContent).toContain('Second setting');
    const sections = scroll.querySelectorAll<HTMLElement>('section');
    Object.defineProperty(sections[0], 'offsetTop', {value: 100}); Object.defineProperty(sections[1], 'offsetTop', {value: 400});
    Object.defineProperty(scroll, 'clientHeight', {value: 200}); Object.defineProperty(scroll, 'scrollHeight', {value: 700});
    const second = document.querySelectorAll<HTMLButtonElement>('.nav-item')[1]!;
    second.click(); fixture.detectChanges();
    expect(second.getAttribute('aria-current')).toBe('true');
    scroll.scrollTop = 100; scroll.dispatchEvent(new Event('scroll')); fixture.detectChanges();
    expect(second.getAttribute('aria-current')).toBe('true');
    scroll.dispatchEvent(new Event('wheel')); scroll.dispatchEvent(new Event('scroll')); fixture.detectChanges();
    expect(document.querySelector('.nav-item[aria-current]')?.textContent).toContain('One');
    scroll.scrollTop = 500; scroll.dispatchEvent(new Event('scroll')); fixture.detectChanges();
    expect(second.getAttribute('aria-current')).toBe('true');
  });
});
