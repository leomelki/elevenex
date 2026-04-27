import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

export type PathAutocompleteKind = 'file' | 'directory' | 'either';
export type PathSuggestionKind = 'file' | 'directory';

export interface PathSuggestion {
  path: string;
  name: string;
  kind: PathSuggestionKind;
  isExactParent: boolean;
  trailingSlashHint: boolean;
}

@Injectable({ providedIn: 'root' })
export class PathAutocompleteService {
  private readonly http = inject(HttpClient);

  suggestPaths(
    input: string,
    targetKind: PathAutocompleteKind,
    preferredStartDirectory?: string,
  ) {
    let params = new HttpParams()
      .set('input', input)
      .set('targetKind', targetKind);

    if (preferredStartDirectory?.trim()) {
      params = params.set('preferredStartDirectory', preferredStartDirectory.trim());
    }

    return this.http.get<PathSuggestion[]>('/api/filesystem/path-suggestions', { params });
  }
}
