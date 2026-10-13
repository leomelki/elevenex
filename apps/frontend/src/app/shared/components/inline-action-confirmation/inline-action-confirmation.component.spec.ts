import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineActionConfirmationComponent } from './inline-action-confirmation.component';

describe('Shared inline action confirmation', () => {
  afterEach(() => document.documentElement.classList.remove('dark'));

  function create(action: 'archive' | 'delete' = 'archive') {
    const fixture = TestBed.createComponent(InlineActionConfirmationComponent);
    fixture.componentRef.setInput('action', action);
    fixture.componentRef.setInput('targetId', 11);
    fixture.detectChanges();
    return fixture;
  }

  it.each(['light', 'dark'])(
    'uses the same compact control for archive and delete in %s mode',
    (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const archive = create();
      const deletion = create('delete');
      const archiveButton = archive.nativeElement.querySelector(
        '[data-session-archive-confirm-id="11"]',
      ) as HTMLButtonElement;
      const deleteButton = deletion.nativeElement.querySelector(
        '[data-session-delete-confirm-id="11"]',
      ) as HTMLButtonElement;
      expect(archiveButton.className).toBe(deleteButton.className);
      expect(archiveButton.textContent?.trim()).toBe('Archive');
      expect(deleteButton.textContent?.trim()).toBe('Delete');
      expect(
        archive.nativeElement
          .querySelector('[data-session-archive-cancel-id="11"]')
          ?.textContent?.trim(),
      ).toBe('×');
      expect(archiveButton.disabled).toBe(true);
    },
  );

  it('only confirms when ready and stops row click propagation', () => {
    const fixture = create();
    const confirm = vi.fn();
    const rowClick = vi.fn();
    fixture.componentInstance.confirm.subscribe(confirm);
    fixture.nativeElement.addEventListener('click', rowClick);
    fixture.componentInstance.confirmAction(new Event('click'));
    expect(confirm).not.toHaveBeenCalled();
    fixture.componentRef.setInput('ready', true);
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-session-archive-confirm-id="11"]',
      ) as HTMLButtonElement
    ).click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('focuses cancel when the controls appear and hides it during an operation', () => {
    const fixture = create();
    TestBed.tick();
    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[data-session-archive-cancel-id="11"]'),
    );
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-session-archive-cancel-id]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Archiving');
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(true);
  });
});
