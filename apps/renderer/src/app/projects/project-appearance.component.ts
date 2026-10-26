import { ChangeDetectionStrategy, Component, ElementRef, computed, input, output, viewChildren } from '@angular/core';
import { FoldComponent, IconComponent, SegmentedComponent } from '../ui';
import { ProjectMarkComponent } from '../tasks/projects/project-mark.component';
import { projectFace, projectHue, projectInitials } from './project-face';
import { PROJECT_EMOJI, PROJECT_HUES, PROJECT_ICONS, type ProjectAppearance } from './project.models';

@Component({
  selector: 'ex-project-appearance',
  imports: [FoldComponent, IconComponent, SegmentedComponent, ProjectMarkComponent],
  templateUrl: './project-appearance.component.html',
  styleUrl: './project-appearance.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectAppearanceComponent {
  readonly appearance = input.required<ProjectAppearance>();
  readonly showFace = input(true);
  readonly disabled = input(false);
  readonly faceHook = input<string>();
  readonly appearanceChange = output<ProjectAppearance>();
  protected readonly face = computed(() => projectFace(this.appearance()));
  protected readonly blank = computed(() => (this.appearance().look || 'letters') === 'letters' && !projectInitials(this.appearance().name));
  protected readonly selectedHue = computed(() => this.appearance().hue || projectHue(this.appearance().name));
  protected readonly choices = computed(() => this.appearance().look === 'icon' ? PROJECT_ICONS : PROJECT_EMOJI);
  protected readonly hues = PROJECT_HUES;
  protected readonly options = computed(() => [{ id: 'letters', label: 'Letters' }, { id: 'emoji', label: 'Emoji' }, { id: 'icon', label: 'Icon' }].map(option => ({ ...option, disabled: this.disabled() })));
  private readonly hueButtons = viewChildren<ElementRef<HTMLButtonElement>>('hueButton');

  protected patch(patch: Partial<ProjectAppearance>): void { if (!this.disabled()) this.appearanceChange.emit({ ...this.appearance(), ...patch }); }
  protected setLook(value: string): void {
    if (value === 'letters' || value === 'emoji' || value === 'icon') this.patch({ look: value });
  }
  protected selected(value: string): boolean { return this.appearance().look === 'icon' ? this.appearance().icon === value : this.appearance().emoji === value; }
  protected choose(value: string): void { this.patch(this.appearance().look === 'icon' ? { icon: value } : { emoji: value }); }
  protected hueKey(event: KeyboardEvent, index: number): void {
    if (this.disabled()) return;
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? PROJECT_HUES.length - 1 : (index + direction + PROJECT_HUES.length) % PROJECT_HUES.length;
    this.patch({ hue: PROJECT_HUES[next] });
    this.hueButtons()[next]?.nativeElement.focus();
  }
}
