import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { catchError, forkJoin, map, of } from 'rxjs';

import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import {
  PathAutocompleteService,
  PathSuggestion,
} from '@/shared/services/path-autocomplete.service';
import { ReposService } from '@/shared/services/repos.service';

@Component({
  selector: 'app-repository-autocomplete-input',
  imports: [PathAutocompleteInputComponent],
  templateUrl: './repository-autocomplete-input.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
})
export class RepositoryAutocompleteInputComponent {
  private readonly reposService = inject(ReposService);
  private readonly pathsService = inject(PathAutocompleteService);
  private readonly pathInput = viewChild(PathAutocompleteInputComponent);

  readonly value = input('');
  readonly inputId = input<string | null>(null);
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);
  readonly disabled = input(false);
  readonly excludedPaths = input<string[]>([]);
  readonly valueChange = output<string>();
  readonly commit = output<string>();

  readonly fetchSuggestions = (query: string) => {
    const pathLike = /[\\/]/.test(query) || query.trim() === '~';
    return forkJoin({
      saved: this.reposService.suggestRepositories(query).pipe(catchError(() => of([]))),
      folders: pathLike
        ? this.pathsService.suggestPaths(query, 'directory').pipe(catchError(() => of([])))
        : of([]),
    }).pipe(
      map(({ saved, folders }) => {
        const excluded = new Set(this.excludedPaths());
        const suggestions: PathSuggestion[] = saved
          .filter((repo) => !excluded.has(repo.path))
          .map((repo) => ({
            ...repo,
            kind: 'directory',
            isExactParent: true,
            trailingSlashHint: false,
            commitOnSelect: true,
            badge: 'Previously used',
          }));
        const seen = new Set([...excluded, ...suggestions.map((item) => item.path)]);
        for (const folder of folders) {
          if (!seen.has(folder.path)) {
            seen.add(folder.path);
            suggestions.push(folder);
          }
        }
        return suggestions.slice(0, 30);
      }),
    );
  };

  focus() {
    this.pathInput()?.focus();
  }

  browse() {
    const current = this.value().trim();
    this.pathInput()?.onInput(/[\\/]/.test(current) || current === '~' ? current : '~/');
    this.focus();
  }
}
