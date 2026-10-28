import { A11yModule } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ButtonComponent } from '../../ui/button/button.component';
import { IconComponent } from '../../ui/icon/icon.component';
import { StatusGlyphComponent } from '../../ui/status/status-glyph.component';
import type { ProjectMark } from '../../tasks/task.models';

/** Confirmation content. Compose inside ModalLayer; the owner performs the final operation. */
@Component({ selector: 'ex-delete-project', imports: [A11yModule, ButtonComponent, IconComponent, StatusGlyphComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './delete-project.component.html', styleUrl: './delete-project.component.css' })
export class DeleteProjectComponent {
  readonly project = input.required<ProjectMark>();
  readonly tasks = input<number | undefined>(0);
  readonly sessions = input<number | undefined>(0);
  readonly running = input(0);
  readonly machine = input('the machine');
  readonly cancelled = output<void>();
  readonly archiveRequested = output<void>();
  readonly deleteConfirmed = output<void>();
}
