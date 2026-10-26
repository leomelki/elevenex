import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FlipDirective, IconComponent, StatusGlyphComponent } from '../../ui';
import type { Project, ProjectActivity } from '../task.models';
import { ProjectMarkComponent } from './project-mark.component';

@Component({
  selector: 'ex-project-rail',
  imports: [ProjectMarkComponent, FlipDirective, IconComponent, StatusGlyphComponent],
  templateUrl: './project-rail.component.html',
  styleUrl: './project-rail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectRailComponent {
  readonly projects = input<readonly Project[]>([]);
  readonly all = input<ProjectActivity | false>({});
  readonly activeId = input('all');
  readonly selectProject = output<string>();
  readonly addProject = output<HTMLElement>();
  protected readonly projectIds = computed(() => this.projects().map(project => project.id));
  readonly reorderProjects = output<readonly string[]>();
  readonly projectMenuRequested = output<{ readonly projectId: string; readonly x: number; readonly y: number }>();
  protected readonly allActivity = computed(() => this.all() || {});
  protected readonly indicatorY = signal<number | null>(null);
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private draggedId: string | undefined;
  private readonly indicator = viewChild<ElementRef<HTMLElement>>('indicator');
  private indicatorAnimation?: Animation;
  private previousActive?: string;

  private previousProjects?: ReadonlySet<string>;
  private additions: Animation[] = [];
  private rings: HTMLElement[] = [];

  constructor() {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const cancel = () => { if (media.matches) { this.clearAdditions(); this.indicatorAnimation?.cancel(); } };
    media.addEventListener('change', cancel);
    afterRenderEffect(() => {
      const projects = this.projects();
      const previous = this.previousProjects;
      this.previousProjects = new Set(projects.map(project => project.id));
      this.clearAdditions();
      // A machine's first project has its own jumpHome/settleMark owner.
      if (!previous?.size || media.matches) return;
      for (const project of projects) {
        if (previous.has(project.id)) continue;
        const tile = Array.from(this.root.querySelectorAll<HTMLElement>('[data-project-id]')).find(tile => tile.dataset['projectId'] === project.id);
        const mark = tile?.querySelector('ex-project-mark');
        if (!tile || !mark?.animate) continue;
        const style = getComputedStyle(tile);
        const delay = parseFloat(style.getPropertyValue('--dur-fast'));
        this.additions.push(mark.animate([{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(1.1)', opacity: 1, offset: .55 }, { transform: 'scale(.97)', offset: .8 }, { transform: 'none', opacity: 1 }], { duration: 520, delay, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'backwards' }));
        const ring = tile.ownerDocument.createElement('span');
        ring.setAttribute('aria-hidden', 'true');
        Object.assign(ring.style, { position: 'absolute', inset: '-3px', borderRadius: 'inherit', border: `2px solid var(--project-${project.hue ?? 'steel'})`, pointerEvents: 'none' });
        tile.append(ring); this.rings.push(ring);
        const animation = ring.animate([{ transform: 'scale(.8)', opacity: .7 }, { transform: 'scale(1.55)', opacity: 0 }], { duration: 620, delay, easing: style.getPropertyValue('--ease-out').trim(), fill: 'both' });
        this.additions.push(animation);
        void animation.finished.then(() => ring.remove(), () => undefined);
      }
    });
    afterRenderEffect({
      earlyRead: () => {
        this.projects();
        this.activeId();
        this.all();
        const selected = this.root.querySelector<HTMLElement>(
          '[aria-current="true"]',
        );
        return selected
          ? selected.offsetTop + (selected.offsetHeight - 20) / 2
          : null;
      },
      write: (position) => this.indicatorY.set(position()),
    });
    afterRenderEffect(() => {
      const active = this.activeId();
      if (this.previousActive !== undefined && this.previousActive !== active) {
        this.indicatorAnimation?.cancel();
        const element = this.indicator()?.nativeElement;
        if (element?.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const style = getComputedStyle(element);
          this.indicatorAnimation = element.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(1.7)', offset: .35 }, { transform: 'scaleY(1)' }], { duration: parseFloat(style.getPropertyValue('--dur-glide')) || 340, easing: style.getPropertyValue('--ease-out').trim() || 'ease-out' });
        }
      }
      this.previousActive = active;
    });
    inject(DestroyRef).onDestroy(() => { this.indicatorAnimation?.cancel(); this.clearAdditions(); media.removeEventListener('change', cancel); });
  }

  private clearAdditions(): void { for (const animation of this.additions) animation.cancel(); this.additions = []; for (const ring of this.rings) ring.remove(); this.rings = []; }
  protected add(tile: HTMLElement): void { this.addProject.emit(tile); }

  protected contextMenu(event: MouseEvent, projectId: string): void {
    event.preventDefault();
    this.projectMenuRequested.emit({ projectId, x: event.clientX, y: event.clientY });
  }

  protected dragStart(event: DragEvent, id: string): void {
    this.draggedId = id;
    event.dataTransfer?.setData('text/plain', id);
  }

  protected dragOver(event: DragEvent): void {
    if (this.draggedId) event.preventDefault();
  }

  protected dragEnd(): void {
    this.draggedId = undefined;
  }

  protected drop(event: DragEvent, index: number): void {
    event.preventDefault();
    const previous = this.projects().findIndex(
      (project) => project.id === this.draggedId,
    );
    this.draggedId = undefined;
    if (previous < 0 || previous === index) return;
    this.move(previous, index);
  }
  protected label(name: string, activity: ProjectActivity): string {
    return activity.muted
      ? `${name}, muted`
      : `${name}${activity.attention ? `, ${activity.attention} need you` : ''}${activity.running ? `, ${activity.running} running` : ''}`;
  }
  protected onKey(event: KeyboardEvent, index: number): void {
    if (
      !event.altKey ||
      !event.shiftKey ||
      !['ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    event.preventDefault();
    const next = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (next < 0 || next >= this.projects().length) return;
    this.move(index, next);
  }

  private move(from: number, to: number): void {
    const ids = this.projects().map((project) => project.id);
    const current = ids[from];
    if (current === undefined) return;
    ids.splice(from, 1);
    ids.splice(to, 0, current);
    this.reorderProjects.emit(ids);
  }
}
