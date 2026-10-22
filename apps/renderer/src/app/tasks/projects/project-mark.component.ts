import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import type { ProjectHue } from '../task.models';

@Component({
  selector: 'ex-project-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.font-size.px]': 'size() * .36',
    '[style.background]': 'background()',
    '[class.large]': 'size() >= 28',
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
  readonly hue = input<ProjectHue>('steel');
  readonly size = input(36);
  readonly decorative = input(false);
  protected readonly failedLogo = signal<string | undefined>(undefined);
  protected readonly background = computed(
    () => `var(--project-${this.hue()})`,
  );
  protected readonly monogram = computed(
    () => this.initials() || this.name().slice(0, 2).toUpperCase(),
  );
}
