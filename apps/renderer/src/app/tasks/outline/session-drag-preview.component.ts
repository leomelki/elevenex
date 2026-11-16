import { DOCUMENT } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { StatusGlyphComponent } from '../../ui';
import type { TaskSession } from '../task.models';

/** Viewport geometry of the hovered group. The extension reaches down from its
 * bottom edge and the chip docks at child depth inside it. */
export interface SessionDock {
  /** Destination root ID; a new destination replays the reach. */
  readonly key: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  /** The destination has hidden children, so the slot follows them. */
  readonly collapsed: boolean;
  /** Visible vertical range of the scrolling outline. */
  readonly clipTop: number;
  readonly clipBottom: number;
}

export interface SessionDragPoint { readonly x: number; readonly y: number }

/** Child rows start after the 16px tree column, its 1px guide and 4px gutter. */
const CHILD_INDENT = 21;
const FREE_MAX_WIDTH = 200;

/** Inert drag ink rendered in a CDK overlay, outside folding/clipped rows. */
@Component({
  selector: 'ex-session-drag-preview',
  imports: [StatusGlyphComponent],
  templateUrl: './session-drag-preview.component.html',
  styleUrl: './session-drag-preview.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class.hidden]': 'hidden()',
    '[class.landing]': 'landing()',
    '[class.leaving]': 'leaving()',
    '[style.clip-path]': 'clip()',
  },
})
export class SessionDragPreviewComponent {
  readonly session = input.required<TaskSession>();
  readonly pointer = input<SessionDragPoint>({ x: 0, y: 0 });
  readonly dock = input<SessionDock | null>(null);
  readonly hidden = input(false);
  /** The drop is committed: the chip holds its slot until the real row arrives. */
  readonly landing = input(false);
  readonly leaving = input(false);
  private readonly document = inject(DOCUMENT);
  private readonly chip = viewChild.required<ElementRef<HTMLElement>>('chip');
  private readonly freeWidth = signal<number | null>(null);
  /** Undocking glides back to the pointer before following it directly again. */
  protected readonly settling = signal(false);
  protected readonly docks = computed(() => {
    const dock = this.dock();
    return dock && !this.landing() ? [dock] : [];
  });
  protected readonly chipWidth = computed(() => {
    const dock = this.dock();
    return dock ? Math.max(0, dock.width - CHILD_INDENT - 4) : this.freeWidth();
  });
  protected readonly chipTransform = computed(() => {
    const dock = this.dock(), point = this.pointer();
    if (dock) return `translate(${dock.left + CHILD_INDENT}px, ${dock.top + 2}px)`;
    const limit = this.document.documentElement.clientWidth - (this.freeWidth() ?? FREE_MAX_WIDTH) - 4;
    return `translate(${Math.max(0, Math.min(point.x + 12, limit))}px, ${point.y + 6}px)`;
  });
  protected readonly clip = computed(() => {
    const dock = this.dock();
    return dock ? `inset(${Math.max(0, dock.clipTop)}px 0 calc(100% - ${dock.clipBottom}px) 0)` : null;
  });

  constructor() {
    afterNextRender(() => this.freeWidth.set(Math.min(this.chip().nativeElement.offsetWidth, FREE_MAX_WIDTH)));
    let docked = false;
    effect(onCleanup => {
      const next = !!this.dock();
      if (docked && !next) {
        this.settling.set(true);
        const timer = setTimeout(() => this.settling.set(false), 200);
        onCleanup(() => clearTimeout(timer));
      } else if (next) this.settling.set(false);
      docked = next;
    });
  }

  /** Current chip bounds, used to land the real row from the ghost. */
  chipRect(): DOMRect { return this.chip().nativeElement.getBoundingClientRect(); }
}
