import { A11yModule } from '@angular/cdk/a11y';
import { OverlayModule } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { BranchPickerComponent } from '../../tasks/branches/branch-picker.component';
import { branchItems } from '../../tasks/branches/branch-options';
import type { BranchRow } from '../../tasks/task.models';
import { IconComponent } from '../../ui/icon/icon.component';
import type { ProjectRepository } from './project-settings.models';

@Component({
  selector: 'ex-repository-branch-picker',
  imports: [A11yModule, OverlayModule, IconComponent, BranchPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './repository-branch-picker.component.html',
  styleUrl: './repository-branch-picker.component.css',
})
export class RepositoryBranchPickerComponent {
  readonly repo = input.required<ProjectRepository>();
  readonly active = input(true);
  readonly changed = output<string>();
  protected readonly open = linkedSignal({
    source: () => this.active() ? this.repo().id : null,
    computation: () => false,
  });
  protected readonly query = signal('');
  protected readonly highlighted = linkedSignal({
    source: () => this.rows(), computation: () => 0,
  });
  protected readonly value = computed(() => this.repo().base ?? 'main');
  private readonly branches = computed(() =>
    Array.from(new Set([this.value(), ...(this.repo().branches ?? [])])).map(name => ({ name })),
  );
  // Bound rendered results, but search every supplied branch, including those beyond the first page.
  protected readonly rows = computed(() => branchItems(this.query(), this.branches()));
  protected readonly listId = `repository-branches-${crypto.randomUUID()}`;

  protected show(): void {
    if (!this.active()) return;
    this.query.set('');
    this.highlighted.set(0);
    this.open.set(true);
  }

  protected choose(row: BranchRow): void {
    if (!this.active() || !this.open() || !this.branches().some(branch => branch.name === row.name)) return;
    this.open.set(false);
    if (row.name !== this.value()) this.changed.emit(row.name);
  }

  protected key(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.open.set(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = this.rows().length;
      if (count) this.highlighted.update(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = this.rows()[this.highlighted()];
      if (row) this.choose(row);
    }
  }
}
