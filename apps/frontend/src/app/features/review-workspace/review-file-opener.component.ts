import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronLeft,
  lucideFile,
  lucideFolder,
  lucideSearch,
  lucideX,
} from '@ng-icons/lucide';
import { FilesService, type FileTreeNode } from '@/shared/services/files.service';

/**
 * Browse the worktree to open a file that has no diff.
 *
 * Deliberately uses `FilesService`, which is repo-relative, rather than the
 * path autocomplete input — that one resolves OS filesystem paths and can walk
 * outside the worktree.
 */
@Component({
  selector: 'app-review-file-opener',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideChevronLeft,
      lucideFile,
      lucideFolder,
      lucideSearch,
      lucideX,
    }),
  ],
  templateUrl: './review-file-opener.component.html',
  styleUrl: './review-file-opener.component.scss',
})
export class ReviewFileOpenerComponent {
  readonly worktreePath = input.required<string>();

  readonly openFile = output<string>();
  readonly dismiss = output<void>();

  private readonly files = inject(FilesService);
  private readonly searchRef = viewChild<ElementRef<HTMLInputElement>>('searchRef');

  readonly dir = signal('');
  readonly entries = signal<FileTreeNode[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly query = signal('');

  readonly visible = computed(() => {
    const query = this.query().trim().toLowerCase();
    const entries = [...this.entries()].sort((left, right) => {
      const leftDir = left.data.type === 'directory';
      const rightDir = right.data.type === 'directory';
      if (leftDir !== rightDir) return leftDir ? -1 : 1;
      return left.label.localeCompare(right.label);
    });
    if (!query) return entries;
    return entries.filter((entry) => entry.label.toLowerCase().includes(query));
  });

  readonly breadcrumb = computed(() =>
    this.dir() ? this.dir().split('/').filter(Boolean) : [],
  );

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      const dir = this.dir();
      void this.list(worktreePath, dir);
    });

    effect(() => {
      this.entries();
      requestAnimationFrame(() => this.searchRef()?.nativeElement.focus());
    });
  }

  enter(entry: FileTreeNode): void {
    if (entry.data.type === 'directory') {
      this.query.set('');
      this.dir.set(entry.data.path);
      return;
    }
    this.openFile.emit(entry.data.path);
  }

  goUp(): void {
    const parts = this.dir().split('/').filter(Boolean);
    parts.pop();
    this.query.set('');
    this.dir.set(parts.join('/'));
  }

  goTo(index: number): void {
    const parts = this.breadcrumb().slice(0, index + 1);
    this.query.set('');
    this.dir.set(parts.join('/'));
  }

  private async list(worktreePath: string, dir: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const entries = await firstValueFrom(
        this.files.listFiles(worktreePath, dir || undefined),
      );
      if (this.dir() !== dir) return;
      this.entries.set(entries);
    } catch {
      if (this.dir() === dir) {
        this.error.set('Could not list this folder.');
        this.entries.set([]);
      }
    } finally {
      if (this.dir() === dir) this.loading.set(false);
    }
  }
}
