import { DOCUMENT } from "@angular/common";
import {
  ChangeDetectionStrategy,
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
  /** Task context for a shortcut outside the task outline. */
  readonly context = input<string | null>(null);
  readonly activated = output<string>();
  readonly archived = input(false);
  readonly allowRestore = input(false);
  readonly restoreRequested = output<TaskSession>();
  readonly allowArchive = input(false);
  readonly archiveRequested = output<TaskSession>();
  protected readonly confirming = signal(false);
  private readonly document = inject(DOCUMENT);
  private confirmationSession: string | null = null;
  private removeOutsideListener?: () => void;

  constructor() { inject(DestroyRef).onDestroy(() => this.cancelArchive()); }
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
