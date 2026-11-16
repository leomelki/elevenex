import { DOCUMENT } from '@angular/common';
import { ComponentRef, DestroyRef, Directive, ElementRef, inject, input, OnChanges, output, signal } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { readSessionDrag } from '../session-drag';
import type { SessionMoveIntent, TaskSession } from '../task.models';
import { SessionDragPreviewComponent } from './session-drag-preview.component';

/** One task owns the native drag, hit testing, preview, announcements and cleanup.
 * Native DataTransfer remains intact so composer mentions still work. */
@Directive({
  selector: '[exSessionNestingDrag]',
  host: { '(dragstart)': 'start($event)' },
})
export class SessionNestingDragDirective implements OnChanges {
  readonly dragSessions = input.required<readonly TaskSession[]>();
  readonly dragTaskId = input.required<string>();
  readonly dragEnabled = input(false);
  readonly sessionDropped = output<SessionMoveIntent>();
  readonly source = signal<TaskSession | null>(null);
  readonly target = signal<TaskSession | null>(null);
  readonly droppedParent = signal<string | null>(null);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);
  private readonly overlay = inject(Overlay);
  private preview?: ComponentRef<SessionDragPreviewComponent>;
  private overlayRef?: OverlayRef;
  private header = false;
  private point = { x: 0, y: 0 };
  private frame = 0;
  private lastFrame = 0;
  private scrollRegion?: HTMLElement;
  private announce?: HTMLElement;
  private nativeImage?: HTMLElement;
  private removeListeners?: () => void;
  private taskIdentity?: string;

  constructor() { inject(DestroyRef).onDestroy(() => this.end()); }
  ngOnChanges(): void {
    if (this.taskIdentity !== this.dragTaskId() || !this.dragEnabled() || (this.source() && !this.dragSessions().some(row => row.id === this.source()?.id))) this.end();
    this.taskIdentity = this.dragTaskId();
  }
  protected start(event: DragEvent): void {
    this.end();
    if (!this.dragEnabled() || !event.dataTransfer || event.defaultPrevented) return;
    const reference = readSessionDrag(event.dataTransfer, this.dragSessions().find(row => row.mentionScope)?.mentionScope);
    const source = reference && this.dragSessions().find(row => row.id === reference.id);
    if (!source || source.local) return;
    this.droppedParent.set(null);
    this.source.set(source);
    this.point = { x: event.clientX, y: event.clientY };
    // Suppress only the immutable native image; retain the browser drag lifecycle.
    const transparent = this.document.createElement('div');
    Object.assign(transparent.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', pointerEvents: 'none' });
    this.document.body.append(transparent);
    event.dataTransfer.setDragImage(transparent, 0, 0);
    this.nativeImage = transparent;
    this.overlayRef = this.overlay.create({ positionStrategy: this.overlay.position().global().left('0px').top('0px'), scrollStrategy: this.overlay.scrollStrategies.noop() });
    this.preview = this.overlayRef.attach(new ComponentPortal(SessionDragPreviewComponent));
    // CDK enables pane input when attaching; apply transparency afterwards.
    this.overlayRef.overlayElement.style.pointerEvents = 'none';
    this.preview.setInput('session', source);
    this.announce = this.document.createElement('span');
    this.announce.setAttribute('role', 'status');
    Object.assign(this.announce.style, { position: 'fixed', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)' });
    this.document.body.append(this.announce);
    const move = (event: DragEvent) => {
      this.point = { x: event.clientX, y: event.clientY };
      this.over(event);
      this.paint();
    };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) { this.setTarget(null, false); if (this.overlayRef) this.overlayRef.overlayElement.style.visibility = 'hidden'; } };
    const end = () => this.end();
    // Capture sees a drop even when the composer stops propagation. Hit testing
    // still confines moves to this task; outside drops keep their native data.
    const onDrop = (event: DragEvent) => this.drop(event);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') this.end(); };
    this.document.addEventListener('dragover', move);
    this.document.addEventListener('dragleave', leave);
    this.document.addEventListener('drop', onDrop, true);
    this.document.addEventListener('dragend', end);
    this.document.addEventListener('keydown', key);
    this.document.defaultView?.addEventListener('blur', end);
    this.removeListeners = () => {
      this.document.removeEventListener('dragover', move);
      this.document.removeEventListener('dragleave', leave);
      this.document.removeEventListener('drop', onDrop, true);
      this.document.removeEventListener('dragend', end);
      this.document.removeEventListener('keydown', key);
      this.document.defaultView?.removeEventListener('blur', end);
    };
    this.scrollRegion = this.findScroller();
    this.paint();
    this.frame = requestAnimationFrame(time => this.scroll(time));
  }
  protected over(event: DragEvent): void {
    if (!this.source()) return;
    this.updateTarget(this.hitTarget(event));
    if (!this.target() && !this.header) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
  protected drop(event: DragEvent): void {
    const source = this.dragSessions().find(row => row.id === this.source()?.id);
    this.updateTarget(this.hitTarget(event));
    const parent = this.target();
    if (source && this.dragEnabled() && (parent || this.header)) {
      event.preventDefault(); event.stopPropagation();
      this.droppedParent.set(parent?.id ?? null);
      this.sessionDropped.emit({ sessionId: source.id, parentSessionId: parent?.id ?? null });
    }
    this.end();
  }
  private hitTarget(event: DragEvent): EventTarget | null {
    // A native drag can retain an old event target after an overlay moves.
    // Re-hit-test the live, pointer-transparent scene at the current point.
    return this.document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
  }
  private updateTarget(node: EventTarget | null): void {
    const source = this.dragSessions().find(row => row.id === this.source()?.id);
    if (!this.dragEnabled() || !source || !(node instanceof Element) || !this.host.contains(node)) { this.setTarget(null, false); return; }
    const rootId = node.closest<HTMLElement>('[data-session-root]')?.dataset['sessionRoot'];
    const parent = this.dragSessions().find(row => row.id === rootId);
    const valid = parent && !parent.parentId && !parent.local && !source.childCount && !this.dragSessions().some(row => row.parentId === source.id) && source.id !== parent.id && source.parentId !== parent.id;
    this.setTarget(valid ? parent : null, !!source.parentId && !!node.closest('[data-session-task-header]'));
  }
  private setTarget(target: TaskSession | null, header: boolean): void {
    const changed = this.target()?.id !== target?.id || this.header !== header;
    this.target.set(target);
    this.header = header;
    this.host.querySelector('[data-session-task-header]')?.classList.toggle('session-drop-root', header);
    if (changed && this.announce) this.announce.textContent = target ? `Nest ${this.source()?.title} under ${target.title}` : header ? `Move ${this.source()?.title} to task level` : '';
  }
  private paint(): void {
    if (!this.overlayRef || !this.preview) return;
    const pane = this.overlayRef.overlayElement;
    pane.style.visibility = this.header ? 'hidden' : '';
    const target = this.target();
    const branch = target && target.childrenAppendOrder !== false ? [...this.host.querySelectorAll<HTMLElement>('[data-session-root]')].find(row => row.dataset['sessionRoot'] === target.id) : undefined;
    const bounds = branch?.getBoundingClientRect();
    const row = branch?.querySelector('.branch-row')?.getBoundingClientRect();
    const region = this.scrollRegion?.getBoundingClientRect();
    const x = bounds ? bounds.left + 36 : Math.min(this.point.x + 12, this.document.documentElement.clientWidth - 200);
    const y = bounds ? bounds.bottom : this.point.y + 12;
    pane.style.transform = `translate(${x}px, ${y}px)`;
    pane.style.width = `${bounds ? Math.max(0, bounds.width - 36) : 188}px`;
    // Clipping and edge scrolling never reserve space or move the list on pickup.
    pane.style.clipPath = bounds && region ? `inset(${Math.max(0, region.top - y)}px 0 ${Math.max(0, y + 28 - region.bottom)}px 0)` : '';
    this.preview.setInput('docked', !!bounds);
    this.preview.setInput('stacked', !!bounds && !!row && bounds.height <= row.height + 1 && !!target?.childCount);
  }
  private findScroller(): HTMLElement | undefined {
    for (let node = this.host.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    }
    return undefined;
  }
  private scroll(time: number): void {
    if (!this.source()) return;
    const region = this.scrollRegion, rect = region?.getBoundingClientRect();
    const elapsed = Math.min(32, this.lastFrame ? time - this.lastFrame : 16);
    this.lastFrame = time;
    if (region && rect && this.point.x >= rect.left && this.point.x <= rect.right && this.point.y >= rect.top && this.point.y <= rect.bottom) {
      const edge = 32;
      const speed = this.point.y < rect.top + edge ? -Math.min(1, (rect.top + edge - this.point.y) / edge) : this.point.y > rect.bottom - edge ? Math.min(1, (this.point.y - rect.bottom + edge) / edge) : 0;
      if (speed) {
        region.scrollTop += speed * elapsed * .35;
        this.updateTarget(this.document.elementFromPoint(this.point.x, this.point.y));
        this.paint();
      }
    }
    this.frame = requestAnimationFrame(next => this.scroll(next));
  }
  private end(): void {
    cancelAnimationFrame(this.frame); this.frame = 0; this.lastFrame = 0;
    this.removeListeners?.(); this.removeListeners = undefined;
    this.setTarget(null, false); this.source.set(null);
    this.overlayRef?.dispose(); this.overlayRef = undefined; this.preview = undefined;
    this.nativeImage?.remove(); this.nativeImage = undefined;
    this.announce?.remove(); this.announce = undefined;
    this.scrollRegion = undefined;
  }
}
