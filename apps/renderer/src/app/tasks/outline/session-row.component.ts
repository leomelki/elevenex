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
import { writeSessionDrag } from '../session-drag';
import { AgentMarkComponent, agentIdentity, sessionAgentTitle } from '../../conversation/agents';
@Component({
  selector: "ex-session-row",
  imports: [AgentMarkComponent, IconComponent, StatusGlyphComponent, TickerComponent, TooltipDirective],
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
  readonly deleteRequested = output<TaskSession>();
  protected readonly confirming = signal(false);
  /** Archiving stops both a working agent and the commands it left running. */
  private readonly live = computed(() => this.session().status === 'running' || !!this.session().commands ||
    !!this.session().activeChildAgents?.length);
  protected readonly archiveLabel = computed(() => {
    const count = this.session().activeChildAgents?.length ?? 0;
    return count ? 'Stop ' + count + (count === 1 ? ' agent' : ' agents') + ' and archive' : 'Stop and archive';
  });
  protected readonly tooltip = computed(() => {
    const row = this.session(), parent = row.delegatedBy;
    if (!parent) return row.title;
    // One fact per line: the tooltip keeps line breaks so provenance reads as a short card.
    return [row.title, 'Started by ' + sessionAgentTitle(parent), agentIdentity(row.agentSelection, true),
      row.delegationDetail ? 'Now: ' + row.delegationDetail : '',
      row.parentWaiting ? 'Reply goes to its parent, which is waiting' : ''].filter(Boolean).join('\n');
  });
  protected readonly commandsLabel = computed(() => {
    const count = this.session().commands ?? 0;
    return count === 1
      ? '1 command still running · the agent may resume when it finishes'
      : `${count} commands still running · the agent may resume when they finish`;
  });
  protected readonly dragging = signal(false);
  protected startDrag(event: DragEvent): void {
    if (!event.dataTransfer || this.confirming() || this.session().local) { event.preventDefault(); return; }
    writeSessionDrag(event.dataTransfer, this.session());
    this.dragging.set(true);
  }
  private readonly document = inject(DOCUMENT);
  private confirmationSession: string | null = null;
  private confirmationAgents?: readonly number[];
  private removeOutsideListener?: () => void;

  constructor() { inject(DestroyRef).onDestroy(() => this.cancelArchive()); }
  ngOnChanges(): void {
    const active = this.session().activeChildAgents;
    if (!this.allowArchive() || !this.live() || this.session().id !== this.confirmationSession ||
        active?.length !== this.confirmationAgents?.length ||
        active?.some(id => !this.confirmationAgents?.includes(id))) this.cancelArchive();
  }

  protected archive(event: Event): void {
    if (!this.allowArchive()) return;
    if (this.session().canDelete) { this.deleteRequested.emit(this.session()); return; }
    if (this.live() && !this.confirming()) {
      this.confirmationSession = this.session().id;
      this.confirmationAgents = this.session().activeChildAgents;
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
    this.confirmationAgents = undefined;
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
