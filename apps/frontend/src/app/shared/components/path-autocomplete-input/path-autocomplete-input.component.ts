import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnChanges,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFile, lucideFolder, lucideLoaderCircle } from '@ng-icons/lucide';
import { debounceTime, map, Observable, of, Subject, switchMap, tap, catchError } from 'rxjs';

import { ZardInputDirective } from '@/shared/components/input';
import {
  PathAutocompleteKind,
  PathAutocompleteService,
  type PathSuggestion,
} from '@/shared/services/path-autocomplete.service';

@Component({
  selector: 'app-path-autocomplete-input',
  standalone: true,
  imports: [CommonModule, FormsModule, OverlayModule, NgIcon, ZardInputDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideFile,
      lucideFolder,
      lucideLoaderCircle,
    }),
  ],
  templateUrl: './path-autocomplete-input.component.html',
  styleUrl: './path-autocomplete-input.component.scss',
})
export class PathAutocompleteInputComponent implements OnChanges {
  private static nextId = 0;
  readonly listId = `path-suggestions-${++PathAutocompleteInputComponent.nextId}`;
  private readonly pathAutocomplete = inject(PathAutocompleteService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly query$ = new Subject<string>();

  @ViewChild('inputEl') private readonly inputEl?: ElementRef<HTMLInputElement>;
  @ViewChild('origin', { read: ElementRef }) private readonly originEl?: ElementRef<HTMLElement>;

  readonly value = input('');
  readonly pathKind = input<PathAutocompleteKind>('either');
  readonly placeholder = input('');
  readonly inputId = input<string | null>(null);
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);
  readonly disabled = input(false);
  readonly preferredStartDirectory = input<string | undefined>(undefined);
  readonly browseLabel = input<string | null>(null);
  readonly suggestionsProvider = input<((query: string) => Observable<PathSuggestion[]>) | null>(
    null,
  );
  readonly loadingLabel = input('Looking for paths…');
  readonly emptyLabel = input('No matching paths');

  readonly valueChange = output<string>();
  readonly commit = output<string>();
  readonly browse = output<void>();

  readonly draftValue = signal('');
  readonly suggestions = signal<PathSuggestion[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly open = signal(false);
  readonly activeIndex = signal(0);
  readonly overlayWidth = signal(320);
  readonly showBrowse = computed(() => Boolean(this.browseLabel()));

  constructor() {
    this.draftValue.set(this.value());

    this.query$
      .pipe(
        debounceTime(120),
        tap(() => {
          this.loading.set(true);
          this.error.set('');
        }),
        switchMap((query) =>
          (
            this.suggestionsProvider()?.(query) ??
            this.pathAutocomplete.suggestPaths(
              query,
              this.pathKind(),
              this.preferredStartDirectory(),
            )
          ).pipe(
            catchError(() => {
              if (query === this.draftValue()) this.error.set('Suggestions are unavailable');
              return of([]);
            }),
            map((items) => ({ items, query })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ items, query }) => {
        if (query !== this.draftValue()) return;
        this.suggestions.set(items);
        this.activeIndex.set(0);
        this.loading.set(false);
      });
  }

  ngOnChanges() {
    this.draftValue.set(this.value());
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMousedown(event: MouseEvent) {
    if (!this.open()) {
      return;
    }

    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) {
      return;
    }

    this.open.set(false);
  }

  onFocus() {
    // Keep quick picks visible when the repository picker first focuses an empty field.
    if (this.suggestionsProvider() && !this.draftValue().trim()) return;
    if (!this.suggestionsProvider() && !this.isPathLike(this.draftValue())) {
      return;
    }

    this.fetchSuggestions(this.draftValue());
  }

  showSuggestions() {
    if (this.suggestionsProvider()) this.fetchSuggestions(this.draftValue());
  }

  focus() {
    this.inputEl?.nativeElement.focus();
  }

  onInput(nextValue: string) {
    this.draftValue.set(nextValue);
    this.valueChange.emit(nextValue);

    if (!this.suggestionsProvider() && !this.isPathLike(nextValue)) {
      this.open.set(false);
      this.suggestions.set([]);
      this.loading.set(false);
      this.error.set('');
      return;
    }

    this.fetchSuggestions(nextValue);
  }

  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && this.open()) {
      event.preventDefault();
      this.open.set(false);
      return;
    }

    if (event.key === 'Enter' && this.open() && this.loading()) {
      event.preventDefault();
      return;
    }

    if (event.key === 'ArrowDown' && !this.open() && this.suggestionsProvider()) {
      event.preventDefault();
      this.fetchSuggestions(this.draftValue());
      return;
    }

    if (!this.open() || !this.suggestions().length) {
      if (event.key === 'Enter') {
        this.commit.emit(this.draftValue());
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.update((index) => Math.min(index + 1, this.suggestions().length - 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.update((index) => Math.max(index - 1, 0));
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      const selected = this.suggestions()[this.activeIndex()];
      if (selected) {
        event.preventDefault();
        this.applySuggestion(selected);
        return;
      }
    }
  }

  applySuggestion(item: PathSuggestion) {
    const separator = this.completionSeparator(this.draftValue(), item.path);
    const itemPath = this.formatPathWithSeparator(item.path, separator);
    const nextValue =
      item.kind === 'directory'
        ? `${this.trimTrailingSeparators(itemPath)}${item.trailingSlashHint ? separator : ''}`
        : itemPath;
    this.draftValue.set(nextValue);
    this.valueChange.emit(nextValue);

    if (item.kind === 'directory' && !item.commitOnSelect) {
      this.fetchSuggestions(nextValue);
      this.focusInputAtEnd(nextValue);
      return;
    }

    this.focusInputAtEnd(nextValue);
    this.open.set(false);
    this.commit.emit(nextValue);
  }

  private focusInputAtEnd(nextValue: string) {
    const el = this.inputEl?.nativeElement;
    if (!el) {
      return;
    }
    el.value = nextValue;
    el.focus();
    const end = nextValue.length;
    try {
      el.setSelectionRange(end, end);
    } catch {
      // some input types don't support selection
    }
    requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });
  }

  private fetchSuggestions(query: string) {
    this.overlayWidth.set(this.originEl?.nativeElement.getBoundingClientRect().width || 320);
    this.open.set(true);
    this.loading.set(true);
    this.suggestions.set([]);
    this.error.set('');
    this.query$.next(query);
  }

  private isPathLike(query: string): boolean {
    const trimmed = query.trim();
    return (
      /^[a-zA-Z]:(?:[\\/]|$)/.test(trimmed) ||
      trimmed.startsWith('\\\\') ||
      trimmed.startsWith('//') ||
      /^[~](?:[\\/]|$)/.test(trimmed) ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\')
    );
  }

  private completionSeparator(query: string, suggestedPath: string): '/' | '\\' {
    const lastForwardSlash = query.lastIndexOf('/');
    const lastBackslash = query.lastIndexOf('\\');

    if (lastForwardSlash > lastBackslash) {
      return '/';
    }

    if (lastBackslash > lastForwardSlash) {
      return '\\';
    }

    return suggestedPath.includes('\\') ? '\\' : '/';
  }

  private formatPathWithSeparator(pathValue: string, separator: '/' | '\\'): string {
    return separator === '/' ? pathValue.replace(/\\/g, '/') : pathValue.replace(/\//g, '\\');
  }

  private trimTrailingSeparators(pathValue: string): string {
    if (/^[a-zA-Z]:[\\/]?$/.test(pathValue)) {
      return pathValue;
    }

    if (/^[\\/]+$/.test(pathValue)) {
      return pathValue;
    }

    return pathValue.replace(/[\\/]+$/, '');
  }
}
