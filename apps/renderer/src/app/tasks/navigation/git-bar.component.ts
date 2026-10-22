import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import {
  ButtonComponent,
  IconComponent,
  KbdComponent,
  StatusGlyphComponent,
} from '../../ui';
import type { GitAction } from '../task.models';
@Component({
  selector: 'ex-git-bar',
  imports: [
    CdkMenuModule,
    ButtonComponent,
    IconComponent,
    KbdComponent,
    StatusGlyphComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './git-bar.component.html',
  styleUrls: ['../tasks-menu.css', './git-bar.component.css'],
})
export class GitBarComponent {
  readonly files = input(0);
  readonly add = input(0);
  readonly del = input(0);
  readonly ahead = input(0);
  readonly busy = input<'commit' | 'push'>();
  readonly compact = input(false);
  readonly action = output<GitAction>();
  readonly changesRequested = output<void>();
  protected readonly step = computed(
    () =>
      this.busy() ?? (this.files() ? 'commit' : this.ahead() ? 'push' : null),
  );
  protected readonly label = computed(() =>
    this.busy() === 'commit'
      ? 'Committing…'
      : this.busy() === 'push'
        ? 'Pushing…'
        : this.step() === 'commit'
          ? 'Commit'
          : 'Push',
  );
  protected readonly count = computed(() =>
    this.busy() ? 0 : this.step() === 'commit' ? this.files() : this.ahead(),
  );
  protected readonly menuItems = computed<
    readonly { readonly action: GitAction; readonly label: string }[]
  >(() =>
    this.step() === 'commit'
      ? [
          { action: 'commit-push', label: 'Commit and push' },
          ...(this.ahead()
            ? [
                {
                  action: 'push' as const,
                  label: `Push the ${this.ahead()} waiting`,
                },
              ]
            : []),
          { action: 'commit-pr', label: 'Commit and open PR' },
          { action: 'sync', label: 'Sync with main' },
        ]
      : [
          { action: 'push-pr', label: 'Push and open PR' },
          { action: 'push-new-name', label: 'Push to a new name' },
          { action: 'sync', label: 'Sync with main' },
        ],
  );
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private observer: ResizeObserver | undefined;
  private labelAnimation: Animation | undefined;

  constructor() {
    afterNextRender(() => this.observeActionWidth());
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.labelAnimation?.cancel();
    });
  }

  /** Observe only the action's intrinsic content, so busy/count changes never move the header. */
  private observeActionWidth(): void {
    const button = this.root.querySelector<HTMLButtonElement>('.primary');
    const content = this.root.querySelector<HTMLElement>('.action-content');
    if (!button || !content || typeof ResizeObserver === 'undefined') return;
    let previousWidth: number | undefined;
    const measure = (): void => {
      const style = getComputedStyle(button);
      const width =
        content.getBoundingClientRect().width +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth);
      if (width === previousWidth) return;
      button.style.width = `${width}px`;
      this.labelAnimation?.cancel();
      if (
        previousWidth !== undefined &&
        this.step() &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches &&
        content.animate
      ) {
        this.labelAnimation = content.animate(
          [
            { opacity: 0, transform: 'translateY(3px)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: parseFloat(style.getPropertyValue('--dur-base')) || 0,
            easing: style.getPropertyValue('--ease-out').trim() || 'linear',
          },
        );
      }
      previousWidth = width;
    };
    measure();
    this.observer = new ResizeObserver(measure);
    this.observer.observe(content);
  }

  protected primary(): void {
    const step = this.step();
    if (step && !this.busy()) this.action.emit(step);
  }
}
