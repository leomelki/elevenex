import { afterRenderEffect, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, input, OnChanges, output, untracked } from '@angular/core';
import { FoldComponent } from '../../ui';
import { ListPresence } from '../../ui/motion/list-presence';
import type { TaskSession } from '../task.models';
import { SessionRowComponent } from './session-row.component';

/** A single reveal owns its scroll animation; rows own only archive folds. */
@Component({
  selector: 'ex-session-batch',
  imports: [FoldComponent, SessionRowComponent],
  templateUrl: './session-batch.component.html',
  styleUrl: './session-batch.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.inert]': 'open() ? null : ""', '[attr.aria-hidden]': '!open()' },
})
export class SessionBatchComponent implements OnChanges {
  readonly sessions = input.required<readonly TaskSession[]>();
  readonly selected = input<string | null>(null);
  readonly muted = input<string | null>(null);
  readonly allowArchive = input(false);
  readonly open = input(true);
  readonly initial = input(false);
  readonly closingDistance = input(0);
  readonly activated = output<string>();
  readonly archiveRequested = output<TaskSession>();
  readonly closed = output<void>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroy = inject(DestroyRef);
  private readonly media = matchMedia('(prefers-reduced-motion: reduce)');
  protected readonly presence = new ListPresence(this.sessions, session => session.id, this.host, this.destroy);
  private animation?: Animation;
  private opening = false;
  private ready = false;
  private from: number | undefined;

  constructor() {
    afterRenderEffect(() => {
      this.open();
      this.sessions();
      untracked(() => {
        const from = this.ready ? this.from ?? this.paintedHeight() : this.initial() ? this.paintedHeight() : 0;
        this.ready = true;
        this.from = undefined;
        this.run(from);
      });
    });
    const reduce = () => { if (this.media.matches) this.finish(); };
    this.media.addEventListener('change', reduce);
    this.destroy.onDestroy(() => {
      this.media.removeEventListener('change', reduce);
      this.animation?.cancel();
    });
  }
  ngOnChanges(): void {
    if (this.ready) this.from = this.paintedHeight();
  }
  paintedHeight(): number { return this.host.getBoundingClientRect().height; }
  private run(from: number): void {
    // Data/status changes during a scroll must not restart its clock.
    if (this.animation && this.open() === this.opening) return;
    this.animation?.cancel();
    this.animation = undefined;
    // Bottom alignment puts closed content above the scroll box. scrollHeight
    // then reports the constrained height, so reversals measure the inner rows.
    const to = this.open() ? this.host.firstElementChild?.getBoundingClientRect().height ?? 0 : 0;
    if (this.media.matches || !this.host.animate || Math.abs(from - to) < 0.5) { this.finish(); return; }
    this.opening = this.open();
    this.host.classList.add('moving');
    this.host.style.height = `${from}px`; // WAAPI does not apply until its first frame.
    const animation = this.host.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: Math.max(440, Math.min(760, 320 + 1.3 * (this.open() ? Math.abs(to - from) : Math.max(from, this.closingDistance())))),
      easing: 'cubic-bezier(0.33, 0, 0.15, 1)', fill: 'both',
    });
    this.animation = animation;
    animation.onfinish = () => { if (this.animation === animation) this.finish(); };
  }
  private finish(): void {
    this.host.style.height = this.open() ? '' : '0px';
    this.host.classList.remove('moving');
    this.animation?.cancel();
    this.animation = undefined;
    if (!this.open() && !this.destroy.destroyed) this.closed.emit();
  }
}
