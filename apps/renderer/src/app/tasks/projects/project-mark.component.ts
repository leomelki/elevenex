import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import type { ProjectHue } from '../task.models';
import { IconComponent } from '../../ui/icon/icon.component';

@Component({
  selector: 'ex-project-mark',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.font-size.px]': 'fontSize()',
    '[style.background]': 'background()',
    '[class.large]': 'size() >= 28',
    '[class.medium]': 'size() >= 20 && size() < 28',
    '[class.emoji]': '!!emoji()',
    '[attr.aria-hidden]': 'decorative() ? true : null',
    '[attr.role]': 'decorative() ? null : "img"',
    '[attr.aria-label]': 'decorative() ? null : name()',
  },
  templateUrl: './project-mark.component.html',
  styleUrl: './project-mark.component.css',
})
export class ProjectMarkComponent {
  readonly name = input.required<string>();
  readonly logo = input<string>();
  readonly initials = input<string>();
  readonly emoji = input<string>();
  readonly icon = input<string>();
  readonly hue = input<ProjectHue>('steel');
  readonly size = input(36);
  readonly decorative = input(false);
  protected readonly fontSize = computed(() => Math.round(this.size() * .36));
  protected readonly iconSize = computed(() => Math.round(this.size() * .5));
  protected readonly failedLogo = signal<string | undefined>(undefined);
  protected readonly background = computed(
    () => this.logo() && this.failedLogo() !== this.logo() ? 'var(--surface-raised)' : `var(--project-${this.hue()})`,
  );
  protected readonly monogram = computed(
    () => this.initials() || this.name().slice(0, 2).toUpperCase(),
  );
}
