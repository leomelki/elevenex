import { OverlayContainer } from '@angular/cdk/overlay';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, Subject } from 'rxjs';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { PathAutocompleteInputComponent } from './path-autocomplete-input.component';
import { PathAutocompleteService } from '@/shared/services/path-autocomplete.service';

@Component({
  standalone: true,
  imports: [PathAutocompleteInputComponent],
  template: `
    <app-path-autocomplete-input
      [value]="value"
      pathKind="either"
      placeholder="/tmp/example"
      browseLabel="Browse"
      (valueChange)="onValueChange($event)"
      (commit)="onCommit($event)"
      (browse)="onBrowse()"
    />
  `,
})
class HostComponent {
  value = '/tmp/fi';
  onValueChange = vi.fn();
  onCommit = vi.fn();
  onBrowse = vi.fn();
}

describe('PathAutocompleteInputComponent', () => {
  const suggestPaths = vi.fn();
  let overlayContainer: OverlayContainer;
  let overlayContainerElement: HTMLElement;

  beforeEach(async () => {
    suggestPaths.mockReset();

    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        {
          provide: PathAutocompleteService,
          useValue: {
            suggestPaths,
          },
        },
      ],
    }).compileComponents();
    
    overlayContainer = TestBed.inject(OverlayContainer);
    overlayContainerElement = overlayContainer.getContainerElement();
  });
  
  afterEach(() => {
    overlayContainer.ngOnDestroy();
  });

  it('opens suggestions after focus and keyboard-selects an item', async () => {
    suggestPaths.mockReturnValue(of([
      { path: '/tmp/file.txt', name: 'file.txt', kind: 'file', isExactParent: true, trailingSlashHint: false },
    ]));

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    input.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 160));
    fixture.detectChanges();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.onCommit).toHaveBeenCalledWith('/tmp/file.txt');
    expect(overlayContainerElement.textContent).toContain('file.txt');
  });

  it('supports arrow navigation, tab completion, and escape dismissal', async () => {
    suggestPaths.mockReturnValue(of([
      { path: '/tmp/alpha', name: 'alpha', kind: 'directory', isExactParent: true, trailingSlashHint: true },
      { path: '/tmp/beta', name: 'beta', kind: 'directory', isExactParent: true, trailingSlashHint: true },
    ]));

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    input.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 160));
    fixture.detectChanges();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.onValueChange).toHaveBeenLastCalledWith('/tmp/beta/');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(overlayContainerElement.querySelector('.pac__panel')).toBeNull();
  });

  it('shows loading and empty states', async () => {
    const subject = new Subject<any[]>();
    suggestPaths.mockReturnValue(subject.asObservable());

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const input = fixture.debugElement.query(By.css('input')).nativeElement as HTMLInputElement;
    input.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 160));
    fixture.detectChanges();

    expect(overlayContainerElement.textContent).toContain('Looking for paths');

    subject.next([]);
    subject.complete();
    fixture.detectChanges();

    expect(overlayContainerElement.textContent).toContain('No matching paths');
  });

  it('keeps the browse action working', () => {
    suggestPaths.mockReturnValue(of([]));

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const button = fixture.debugElement.query(By.css('.pac__browse')).nativeElement as HTMLButtonElement;
    button.click();

    expect(fixture.componentInstance.onBrowse).toHaveBeenCalled();
  });
});
