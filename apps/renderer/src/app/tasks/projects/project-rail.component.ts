import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { IconComponent, StatusGlyphComponent } from '../../ui';
import type { Project, ProjectActivity } from '../task.models';
import { ProjectMarkComponent } from './project-mark.component';

@Component({
  selector: 'ex-project-rail',
  imports: [ProjectMarkComponent, IconComponent, StatusGlyphComponent],
  templateUrl: './project-rail.component.html',
  styleUrl: './project-rail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectRailComponent {
  readonly projects = input<readonly Project[]>([]);
  readonly all = input<ProjectActivity | false>({});
  readonly activeId = input('all');
  readonly selectProject = output<string>();
  readonly addProject = output<void>();
  readonly reorderProjects = output<readonly string[]>();
  protected readonly allActivity = computed(() => this.all() || {});
  protected readonly indicatorY = signal<number | null>(null);
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private draggedId: string | undefined;

  constructor() {
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
