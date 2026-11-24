import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, viewChild, viewChildren } from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent, SegmentedComponent } from '../ui';
import { ProjectMarkComponent } from '../tasks/projects/project-mark.component';
import { projectFace, projectHue, projectInitials } from './project-face';
import { PROJECT_IMAGE_ACCEPT, readProjectImage } from './project-image';
import { PROJECT_EMOJI, PROJECT_HUES, PROJECT_ICONS, type ProjectAppearance } from './project.models';

@Component({
  selector: 'ex-project-appearance',
  imports: [ButtonComponent, FoldComponent, IconComponent, SegmentedComponent, ProjectMarkComponent],
  templateUrl: './project-appearance.component.html',
  styleUrl: './project-appearance.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectAppearanceComponent {
  readonly appearance = input.required<ProjectAppearance>();
  readonly showFace = input(true);
  readonly disabled = input(false);
  readonly active = input(true);
  readonly allowImage = input(true);
  readonly faceHook = input<string>();
  readonly appearanceChange = output<ProjectAppearance>();
  protected readonly face = computed(() => projectFace(this.appearance()));
  protected readonly blank = computed(() => !this.face().logo && (this.appearance().look || 'letters') === 'letters' && !projectInitials(this.appearance().name));
  protected readonly selectedHue = computed(() => this.appearance().hue || projectHue(this.appearance().name));
  protected readonly choices = computed(() => this.appearance().look === 'icon' ? PROJECT_ICONS : PROJECT_EMOJI);
  protected readonly hues = PROJECT_HUES;
  protected readonly options = computed(() => [{ id: 'letters', label: 'Letters' }, { id: 'emoji', label: 'Emoji' }, { id: 'icon', label: 'Icon' }].map(option => ({ ...option, disabled: this.disabled() || this.imagePending() })));
  private readonly hueButtons = viewChildren<ElementRef<HTMLButtonElement>>('hueButton');
  private readonly chooseButton = viewChild<unknown, ElementRef<HTMLButtonElement>>('chooseButton', { read: ElementRef });
  private readonly imageRequest = signal<AbortController | null>(null);
  readonly imagePending = computed(() => this.imageRequest() !== null);
  protected readonly imageError = signal('');
  protected readonly imageAccept = PROJECT_IMAGE_ACCEPT;
  protected readonly imageHintId = `project-image-${crypto.randomUUID()}`;
  protected readonly imageUnavailable = computed(() => !this.active() || this.disabled() || !this.allowImage() || this.imagePending());

  constructor() {
    effect(() => {
      if (!this.active() || !this.allowImage() || this.disabled()) this.cancelImage();
    });
    inject(DestroyRef).onDestroy(() => this.cancelImage());
  }

  private cancelImage(): void {
    this.imageRequest()?.abort();
    this.imageRequest.set(null);
  }

  protected async chooseImage(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.imageUnavailable()) return;
    const request = new AbortController();
    this.imageRequest.set(request);
    this.imageError.set('');
    try {
      const image = await readProjectImage(file, request.signal);
      if (request.signal.aborted) return;
      this.imageRequest.set(null);
      if (!this.imageUnavailable()) this.patch({ image });
    } catch (error) {
      if (!request.signal.aborted) {
        this.imageRequest.set(null);
        if (!this.imageUnavailable()) this.imageError.set(error instanceof Error ? error.message : 'This image could not be opened.');
      }
    }
  }

  protected removeImage(): void {
    if (this.imageUnavailable()) return;
    this.imageError.set('');
    this.chooseButton()?.nativeElement.focus();
    this.patch({ image: null });
  }

  protected patch(patch: Partial<ProjectAppearance>): void {
    if (this.active() && !this.disabled() && !this.imagePending()) this.appearanceChange.emit({ ...this.appearance(), ...patch });
  }
  protected setLook(value: string): void {
    if (value === 'letters' || value === 'emoji' || value === 'icon') this.patch({ look: value });
  }
  protected selected(value: string): boolean { return this.appearance().look === 'icon' ? this.appearance().icon === value : this.appearance().emoji === value; }
  protected choose(value: string): void { this.patch(this.appearance().look === 'icon' ? { icon: value } : { emoji: value }); }
  protected hueKey(event: KeyboardEvent, index: number): void {
    if (!this.active() || this.disabled() || this.imagePending()) return;
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? PROJECT_HUES.length - 1 : (index + direction + PROJECT_HUES.length) % PROJECT_HUES.length;
    this.patch({ hue: PROJECT_HUES[next] });
    this.hueButtons()[next]?.nativeElement.focus();
  }
}
