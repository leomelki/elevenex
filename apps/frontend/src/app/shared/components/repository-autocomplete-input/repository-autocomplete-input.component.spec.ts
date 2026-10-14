import { TestBed } from '@angular/core/testing';
import { OverlayContainer } from '@angular/cdk/overlay';
import { firstValueFrom, of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RepositoryAutocompleteInputComponent } from './repository-autocomplete-input.component';
import { PathAutocompleteService } from '@/shared/services/path-autocomplete.service';
import { ReposService } from '@/shared/services/repos.service';

describe('RepositoryAutocompleteInputComponent', () => {
  const suggestRepositories = vi.fn();
  const suggestPaths = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    suggestRepositories.mockReturnValue(of([{ name: 'api', path: '/work/api' }]));
    suggestPaths.mockReturnValue(of([]));
    await TestBed.configureTestingModule({
      imports: [RepositoryAutocompleteInputComponent],
      providers: [
        { provide: ReposService, useValue: { suggestRepositories } },
        { provide: PathAutocompleteService, useValue: { suggestPaths } },
      ],
    }).compileComponents();
  });

  afterEach(() => TestBed.inject(OverlayContainer).ngOnDestroy());

  it('searches repository names and commits a saved repository with the keyboard', async () => {
    const fixture = TestBed.createComponent(RepositoryAutocompleteInputComponent);
    const changed = vi.fn();
    const committed = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed);
    fixture.componentInstance.commit.subscribe(committed);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.focus();
    input.value = 'api';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 160));
    fixture.detectChanges();
    const panel = TestBed.inject(OverlayContainer).getContainerElement();
    expect(panel.textContent).toContain('Previously used');
    expect(suggestRepositories).toHaveBeenCalledWith('api');
    expect(suggestPaths).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(changed).toHaveBeenLastCalledWith('/work/api');
    expect(committed).toHaveBeenCalledWith('/work/api');
    expect(panel.querySelector('.pac__panel')).toBeNull();
  });

  it('combines saved repositories and folder suggestions without duplicates or already selected paths', async () => {
    suggestRepositories.mockReturnValue(
      of([
        { name: 'api', path: '/work/api' },
        { name: 'selected', path: '/work/selected' },
      ]),
    );
    suggestPaths.mockReturnValue(
      of([
        {
          name: 'api',
          path: '/work/api',
          kind: 'directory',
          isExactParent: true,
          trailingSlashHint: true,
        },
        {
          name: 'selected',
          path: '/work/selected',
          kind: 'directory',
          isExactParent: true,
          trailingSlashHint: true,
        },
        {
          name: 'new-folder',
          path: '/work/new-folder',
          kind: 'directory',
          isExactParent: true,
          trailingSlashHint: true,
        },
      ]),
    );
    const fixture = TestBed.createComponent(RepositoryAutocompleteInputComponent);
    fixture.componentRef.setInput('excludedPaths', ['/work/selected']);
    const results = await firstValueFrom(fixture.componentInstance.fetchSuggestions('/work/'));
    expect(results.map((item) => item.path)).toEqual(['/work/api', '/work/new-folder']);
    expect(results[0].commitOnSelect).toBe(true);
    expect(results[1].commitOnSelect).not.toBe(true);
  });

  it('does not select stale options while the next search is loading', async () => {
    const pending = new Subject<{ name: string; path: string }[]>();
    suggestRepositories.mockReturnValueOnce(pending.asObservable());
    const fixture = TestBed.createComponent(RepositoryAutocompleteInputComponent);
    const committed = vi.fn();
    fixture.componentInstance.commit.subscribe(committed);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.focus();
    input.value = 'old';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 160));
    input.value = 'current';
    input.dispatchEvent(new Event('input'));
    pending.next([{ name: 'old', path: '/work/old' }]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(committed).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(pending.observed).toBe(false);
  });
});
