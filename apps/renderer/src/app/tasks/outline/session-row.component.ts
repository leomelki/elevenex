import { DOCUMENT } from "@angular/common";
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  inject,
  OnChanges,
  signal,
  input,
  output,
} from "@angular/core";
import { IconComponent, StatusGlyphComponent, TickerComponent, TooltipDirective } from "../../ui";
import type { TaskSession } from "../task.models";
import { writeSessionDrag } from '../session-drag';
@Component({
  selector: "ex-session-row",
  imports: [IconComponent, StatusGlyphComponent, TickerComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./session-row.component.html",
  styleUrl: "./session-row.component.css",
})
export class SessionRowComponent implements OnChanges {
  readonly session = input.required<TaskSession>();
  readonly selected = input(false);
  /** Only the first visible title at the cap boundary is muted. */
  readonly muted = input(false);
  readonly depth = input(0);
  /** Drag feedback: the row is the drop destination or the session being moved. */
  readonly emphasis = input(false);
  /** Drag feedback: the row cannot accept the dragged session. */
  readonly receded = input(false);
  /** Task context for a shortcut outside the task outline. */
  readonly context = input<string | null>(null);
  readonly activated = output<string>();
  readonly archived = input(false);
  readonly allowRestore = input(false);
  readonly restoreRequested = output<TaskSession>();
  readonly allowArchive = input(false);
  readonly archiveRequested = output<TaskSession>();
  protected readonly confirming = signal(false);
  protected readonly dragging = signal(false);
  protected startDrag(event: DragEvent): void {
    this.endDrag();
    if (!event.dataTransfer || this.confirming() || this.session().local) { event.preventDefault(); return; }
    writeSessionDrag(event.dataTransfer, this.session());
    this.dragging.set(true);
    // A drop can be handled elsewhere, and native dragend can arrive after the
    // move's reply. Release the source feedback on the drop itself.
    const end = () => this.endDrag();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') this.endDrag(); };
    this.document.addEventListener('drop', end, true);
    this.document.addEventListener('dragend', end, true);
    this.document.addEventListener('keydown', key);
    this.document.defaultView?.addEventListener('blur', end);
    this.removeDragListeners = () => {
      this.document.removeEventListener('drop', end, true);
      this.document.removeEventListener('dragend', end, true);
      this.document.removeEventListener('keydown', key);
      this.document.defaultView?.removeEventListener('blur', end);
    };
  }
  protected endDrag(): void {
    const wasDragging = this.dragging();
    this.dragging.set(false);
    this.removeDragListeners?.();
    this.removeDragListeners = undefined;
    // Native drag completion can defer the zoneless render. Clear the cursor
    // and opacity bindings before returning to Chromium's drag loop.
    if (wasDragging && !this.destroy.destroyed) this.changeDetector.detectChanges();
  }
  private readonly document = inject(DOCUMENT);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly destroy = inject(DestroyRef);
  private confirmationSession: string | null = null;
  private removeOutsideListener?: () => void;
  private removeDragListeners?: () => void;

  constructor() { this.destroy.onDestroy(() => { this.cancelArchive(); this.endDrag(); }); }
  ngOnChanges(): void {
    if (!this.allowArchive() || this.session().status !== 'running' || this.session().id !== this.confirmationSession) this.cancelArchive();
  }

  protected archive(event: Event): void {
    if (!this.allowArchive()) return;
    if (this.session().status === 'running' && !this.confirming()) {
      this.confirmationSession = this.session().id;
      this.confirming.set(true);
      const button = event.currentTarget;
      const outside = (event: PointerEvent) => {
        if (button instanceof HTMLElement && event.target instanceof Node && !button.contains(event.target)) this.cancelArchive();
      };
      this.document.addEventListener('pointerdown', outside);
      this.removeOutsideListener = () => this.document.removeEventListener('pointerdown', outside);
      return;
    }
    this.cancelArchive();
    this.archiveRequested.emit(this.session());
  }
  protected cancelArchive(event?: Event): void {
    if (event && this.confirming()) { event.preventDefault(); event.stopPropagation(); }
    this.confirmationSession = null;
    this.confirming.set(false);
    this.removeOutsideListener?.();
    this.removeOutsideListener = undefined;
  }
  protected readonly kindIcon = computed(() =>
    this.session().kind === "fork"
      ? "fork"
      : this.session().kind === "side"
        ? "side-chat"
        : this.session().kind === "auto"
          ? "bolt"
          : null,
  );
}
