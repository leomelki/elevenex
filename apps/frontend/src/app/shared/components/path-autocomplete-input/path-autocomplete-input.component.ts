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
import { debounceTime, distinctUntilChanged, of, Subject, switchMap, tap, catchError } from 'rxjs';

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
  template: `
    <div class="pac" cdkOverlayOrigin #origin="cdkOverlayOrigin">
      <div class="pac__field" [class.pac__field--attached]="showBrowse()" [class.pac__field--disabled]="disabled()">
        <input
          #inputEl
          z-input
          zBorderless
          type="text"
          [id]="inputId()"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
          class="pac__input font-mono"
          [placeholder]="placeholder()"
          [disabled]="disabled()"
          [value]="draftValue()"
          (focus)="onFocus()"
          (input)="onInput(($any($event.target).value || '').toString())"
          (keydown)="onKeydown($event)" />

        @if (showBrowse()) {
          <button
            type="button"
            class="pac__browse"
            [disabled]="disabled()"
            (click)="browse.emit()"
          >
            {{ browseLabel() }}
          </button>
        }
      </div>

      <ng-template
        cdkConnectedOverlay
        [cdkConnectedOverlayOpen]="open()"
        [cdkConnectedOverlayOrigin]="origin"
        [cdkConnectedOverlayHasBackdrop]="false"
        [cdkConnectedOverlayPush]="true"
        [cdkConnectedOverlayMinWidth]="overlayWidth()"
        [cdkConnectedOverlayOffsetY]="6">
        <div class="pac__panel" role="listbox">
          @if (loading()) {
            <div class="pac__state">
              <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
              <span>Looking for paths…</span>
            </div>
          } @else if (error()) {
            <div class="pac__state pac__state--muted">{{ error() }}</div>
          } @else if (suggestions().length) {
            @for (item of suggestions(); track item.path; let index = $index) {
              <button
                type="button"
                class="pac__item"
                [class.pac__item--active]="index === activeIndex()"
                (mouseenter)="activeIndex.set(index)"
                (mousedown)="$event.preventDefault(); applySuggestion(item)"
              >
                <ng-icon [name]="item.kind === 'directory' ? 'lucideFolder' : 'lucideFile'" size="14" />
                <span class="pac__item-name">{{ item.name }}</span>
                @if (item.trailingSlashHint) {
                  <span class="pac__item-tail">/</span>
                }
                <span class="pac__item-path">{{ item.path }}</span>
              </button>
            }
          } @else {
            <div class="pac__state pac__state--muted">No matching paths</div>
          }
        </div>
      </ng-template>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }
    .pac {
      position: relative;
      min-width: 0;
    }
    .pac__field {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      min-width: 0;
      border: 1px solid var(--input, var(--border));
      border-radius: 0.375rem;
      background: transparent;
      transition: box-shadow 120ms ease, border-color 120ms ease;
    }
    .pac__field:focus-within {
      border-color: var(--ring);
      box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
    }
    .pac__field--disabled {
      opacity: 0.5;
    }
    .pac__field--attached {
      gap: 0;
    }
    .pac__input {
      min-width: 0;
      padding-inline: 0.75rem;
    }
    .pac__browse {
      flex: 0 0 auto;
      align-self: stretch;
      padding: 0 0.875rem;
      border: 0;
      border-left: 1px solid var(--border);
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 0.875rem;
      cursor: pointer;
    }
    .pac__browse:disabled {
      cursor: not-allowed;
    }
    .pac__panel {
      max-height: 18rem;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      background: var(--popover);
      color: var(--popover-foreground);
      box-shadow: 0 14px 32px -16px color-mix(in oklab, #000 28%, transparent);
      padding: 0.375rem;
      z-index: 40;
    }
    .pac__item {
      display: grid;
      grid-template-columns: auto auto auto 1fr;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      min-width: 30rem;
      padding: 0.5rem 0.625rem;
      border: 0;
      border-radius: 0.5rem;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      font: inherit;
      font-size: 0.8125rem;
    }
    .pac__item:hover,
    .pac__item--active {
      background: color-mix(in oklab, var(--foreground) 6%, transparent);
    }
    .pac__item-name {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 600;
    }
    .pac__item-tail {
      color: var(--muted-foreground);
    }
    .pac__item-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted-foreground);
      font-size: 0.75rem;
    }
    .pac__state {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      font-size: 0.8125rem;
    }
    .pac__state--muted {
      color: var(--muted-foreground);
    }
  `],
})
export class PathAutocompleteInputComponent implements OnChanges {
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
  readonly disabled = input(false);
  readonly preferredStartDirectory = input<string | undefined>(undefined);
  readonly browseLabel = input<string | null>(null);

  readonly valueChange = output<string>();
  readonly commit = output<string>();
  readonly browse = output<void>();

  readonly draftValue = signal('');
  readonly suggestions = signal<PathSuggestion[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly open = signal(false);
  readonly activeIndex = signal(0);
  readonly overlayWidth = computed(() => this.originEl?.nativeElement.getBoundingClientRect().width ?? 320);
  readonly showBrowse = computed(() => Boolean(this.browseLabel()));

  constructor() {
    this.draftValue.set(this.value());

    this.query$
      .pipe(
        debounceTime(120),
        distinctUntilChanged(),
        tap(() => {
          this.loading.set(true);
          this.error.set('');
        }),
        switchMap(query =>
          this.pathAutocomplete.suggestPaths(query, this.pathKind(), this.preferredStartDirectory()).pipe(
            catchError(() => {
              this.error.set('Suggestions are unavailable');
              return of([]);
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(items => {
        this.suggestions.set(items);
        this.activeIndex.set(0);
        this.loading.set(false);
        this.open.set(this.isPathLike(this.draftValue()));
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
    if (!this.isPathLike(this.draftValue())) {
      return;
    }

    this.fetchSuggestions(this.draftValue());
  }

  onInput(nextValue: string) {
    this.draftValue.set(nextValue);
    this.valueChange.emit(nextValue);

    if (!this.isPathLike(nextValue)) {
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

    if (!this.open() || !this.suggestions().length) {
      if (event.key === 'Enter') {
        this.commit.emit(this.draftValue());
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.update(index => Math.min(index + 1, this.suggestions().length - 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.update(index => Math.max(index - 1, 0));
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
    const nextValue = item.kind === 'directory' ? `${item.path}${item.trailingSlashHint ? '/' : ''}` : item.path;
    this.draftValue.set(nextValue);
    this.valueChange.emit(nextValue);

    if (item.kind === 'directory') {
      this.fetchSuggestions(nextValue);
      this.focusInputAtEnd(nextValue);
      return;
    }

    this.open.set(false);
    this.commit.emit(nextValue);
    this.focusInputAtEnd(nextValue);
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
    this.open.set(true);
    this.query$.next(query);
  }

  private isPathLike(query: string): boolean {
    const trimmed = query.trim();
    return trimmed.startsWith('/') || trimmed.startsWith('~');
  }
}
