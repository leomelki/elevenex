import { DOCUMENT } from '@angular/common';
import { afterNextRender, ComponentRef, computed, DestroyRef, Directive, ElementRef, inject, Injector, input, OnChanges, output, signal } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { readSessionDrag } from '../session-drag';
import type { SessionMoveIntent, TaskSession } from '../task.models';
import { SessionDragPreviewComponent, type SessionDock } from './session-drag-preview.component';

/** A committed nest whose confirmed row has not arrived yet. */
interface SessionLanding { readonly sessionId: string; readonly parentId: string }

/** Upper bound for holding the ghost while the backend confirms a move. */
const LANDING_LIMIT_MS = 1500;

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
  /** A child is held over the task header and would move to task level. */
  readonly toTaskLevel = signal(false);
  readonly landing = signal<SessionLanding | null>(null);
  readonly droppedParent = signal<string | null>(null);
  /** The hovered group shows the docked slot, not only its highlight. */
  readonly docked = computed(() => { const target = this.target(); return !!target && target.childrenAppendOrder !== false; });
  /** Only an active drag lifts the source; a pending landing must not dim it. */
  readonly movingId = computed(() => this.source()?.id ?? null);
  private readonly liveSource = computed(() => this.dragSessions().find(row => row.id === this.source()?.id));
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);
  private readonly overlay = inject(Overlay);
  private readonly injector = inject(Injector);
  private preview?: ComponentRef<SessionDragPreviewComponent>;
  private overlayRef?: OverlayRef;
  private point = { x: 0, y: 0 };
  private outside = false;
  private frame = 0;
  private lastFrame = 0;
  private landingTimer?: ReturnType<typeof setTimeout>;
  private scrollRegion?: HTMLElement;
  private announce?: HTMLElement;
  private nativeImage?: HTMLElement;
  private removeListeners?: () => void;
  private taskIdentity?: string;

  constructor() { inject(DestroyRef).onDestroy(() => this.end()); }
  ngOnChanges(): void {
    if (this.taskIdentity !== this.dragTaskId() || !this.dragEnabled() || (this.source() && !this.liveSource())) this.end();
    this.taskIdentity = this.dragTaskId();
    const landing = this.landing();
    if (landing && this.dragSessions().some(row => row.id === landing.sessionId && row.parentId === landing.parentId)) this.land(landing);
  }
  /** Whether the dragged session may become a child of `parent`. */
  accepts(parent: TaskSession): boolean {
    const source = this.liveSource();
    return !!source && !parent.parentId && !parent.local && !source.childCount && source.id !== parent.id && source.parentId !== parent.id
      && !this.dragSessions().some(row => row.parentId === source.id);
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
    if (source.parentId) this.header()?.classList.add('session-drop-ready');
    const move = (event: DragEvent) => {
      this.point = { x: event.clientX, y: event.clientY };
      this.outside = false;
      this.over(event);
      this.paint();
    };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) { this.outside = true; this.setTarget(null, false); this.paint(); } };
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
    if (!this.target() && !this.toTaskLevel()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
  protected drop(event: DragEvent): void {
    const source = this.liveSource();
    this.updateTarget(this.hitTarget(event));
    const parent = this.target();
    if (source && this.dragEnabled() && (parent || this.toTaskLevel())) {
      event.preventDefault(); event.stopPropagation();
      this.droppedParent.set(parent?.id ?? null);
      const docked = this.docked();
      this.sessionDropped.emit({ sessionId: source.id, parentSessionId: parent?.id ?? null });
      if (parent && docked) { this.hold({ sessionId: source.id, parentId: parent.id }); return; }
    }
    this.end();
  }
  private hitTarget(event: DragEvent): EventTarget | null {
    // A native drag can retain an old event target after an overlay moves.
    // Re-hit-test the live, pointer-transparent scene at the current point.
    return this.document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
  }
  private updateTarget(node: EventTarget | null): void {
    const source = this.liveSource();
    if (!this.dragEnabled() || !source || !(node instanceof Element) || !this.host.contains(node)) { this.setTarget(null, false); return; }
    const rootId = node.closest<HTMLElement>('[data-session-root]')?.dataset['sessionRoot'];
    const parent = this.dragSessions().find(row => row.id === rootId);
    this.setTarget(parent && this.accepts(parent) ? parent : null, !!source.parentId && !!node.closest('[data-session-task-header]'));
  }
  private setTarget(target: TaskSession | null, toTaskLevel: boolean): void {
    const changed = this.target()?.id !== target?.id || this.toTaskLevel() !== toTaskLevel;
    this.target.set(target);
    this.toTaskLevel.set(toTaskLevel);
    this.header()?.classList.toggle('session-drop-root', toTaskLevel);
    if (changed && this.announce) this.announce.textContent = target ? `Nest ${this.source()?.title} under ${target.title}` : toTaskLevel ? `Move ${this.source()?.title} to task level` : '';
  }
  private paint(): void {
    if (!this.preview) return;
    this.preview.setInput('hidden', this.outside);
    this.preview.setInput('pointer', this.point);
    this.preview.setInput('dock', this.dockGeometry());
  }
  private dockGeometry(): SessionDock | null {
    const target = this.target();
    if (!target || !this.docked()) return null;
    const branch = [...this.host.querySelectorAll<HTMLElement>('[data-session-root]')].find(row => row.dataset['sessionRoot'] === target.id);
    if (!branch) return null;
    const bounds = branch.getBoundingClientRect();
    const row = branch.querySelector('.branch-row')?.getBoundingClientRect();
    const region = this.scrollRegion?.getBoundingClientRect();
    return {
      key: target.id, left: bounds.left, top: bounds.bottom, width: bounds.width,
      collapsed: !!row && bounds.height <= row.height + 1 && !!target.childCount,
      clipTop: region?.top ?? 0, clipBottom: region?.bottom ?? this.document.documentElement.clientHeight,
    };
  }
  /** Keep the steady ghost in its slot until the confirmed row replaces it. */
  private hold(landing: SessionLanding): void {
    this.release();
    this.landing.set(landing);
    this.preview?.setInput('landing', true);
    this.landingTimer = setTimeout(() => this.end(), LANDING_LIMIT_MS);
  }
  /** The confirmed row arrived: it glides from the ghost while the ghost fades. */
  private land(landing: SessionLanding): void {
    this.landing.set(null);
    clearTimeout(this.landingTimer);
    const preview = this.preview;
    if (!preview || this.reducedMotion()) { this.end(); return; }
    const from = preview.instance.chipRect();
    preview.setInput('leaving', true);
    this.landingTimer = setTimeout(() => this.end(), this.duration('--dur-base', 200));
    afterNextRender(() => {
      const row = this.host.querySelector<HTMLElement>(`[data-session-root="${CSS.escape(landing.parentId)}"] .children [data-session-id="${CSS.escape(landing.sessionId)}"]`);
      const to = row?.getBoundingClientRect();
      if (!row || !to?.height) return;
      row.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }],
        { duration: this.duration('--dur-slow', 280), easing: getComputedStyle(row).getPropertyValue('--ease-out').trim() || 'ease-out' });
    }, { injector: this.injector });
  }
  private header(): HTMLElement | null { return this.host.querySelector<HTMLElement>('[data-session-task-header]'); }
  private reducedMotion(): boolean { return !!this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
  private duration(token: string, fallback: number): number { return parseFloat(getComputedStyle(this.host).getPropertyValue(token)) || fallback; }
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
  /** Stop aiming: listeners, edge scrolling, hints and announcements. */
  private release(): void {
    cancelAnimationFrame(this.frame); this.frame = 0; this.lastFrame = 0;
    this.removeListeners?.(); this.removeListeners = undefined;
    this.setTarget(null, false); this.source.set(null); this.outside = false;
    this.header()?.classList.remove('session-drop-ready');
    this.announce?.remove(); this.announce = undefined;
    this.nativeImage?.remove(); this.nativeImage = undefined;
    this.scrollRegion = undefined;
  }
  private end(): void {
    this.release();
    clearTimeout(this.landingTimer); this.landingTimer = undefined;
    this.landing.set(null);
    this.overlayRef?.dispose(); this.overlayRef = undefined; this.preview = undefined;
  }
}
