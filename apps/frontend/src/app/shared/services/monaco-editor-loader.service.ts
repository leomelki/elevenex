import { Injectable } from '@angular/core';
import type { Environment } from 'monaco-editor';

export interface MonacoEditorModel {
  getValue(): string;
  setValue(value: string): void;
  getValueInRange(range: MonacoSelection): string;
  dispose(): void;
}

export interface MonacoSelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface MonacoEditorInstance {
  getValue(): string;
  setValue(value: string): void;
  getSelection(): MonacoSelection | null;
  setSelection(selection: MonacoSelection): void;
  revealLineInCenter(lineNumber: number): void;
  layout(): void;
  focus(): void;
  dispose(): void;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
  onDidChangeCursorSelection(listener: () => void): { dispose(): void };
  deltaDecorations(oldDecorations: string[], newDecorations: unknown[]): string[];
  getModel(): MonacoEditorModel | null;
  setModel(model: MonacoEditorModel): void;
}

export interface MonacoApi {
  Uri: {
    parse(value: string): unknown;
  };
  Range: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ) => unknown;
  editor: {
    create(element: HTMLElement, options: Record<string, unknown>): MonacoEditorInstance;
    createModel(value: string, language?: string, uri?: unknown): MonacoEditorModel;
    getModel(uri: unknown): MonacoEditorModel | null;
    setModelLanguage(model: MonacoEditorModel, languageId: string): void;
    setTheme(themeName: string): void;
  };
  languages: {
    getLanguages(): Array<{ id: string; extensions?: string[]; filenames?: string[] }>;
  };
};

declare global {
  interface Window {
    monaco?: MonacoApi;
  }
}

@Injectable({ providedIn: 'root' })
export class MonacoEditorLoaderService {
  private loadPromise: Promise<MonacoApi> | null = null;

  load(): Promise<MonacoApi> {
    if (window.monaco) {
      return Promise.resolve(window.monaco);
    }

    if (!this.loadPromise) {
      const attempt = this.loadMonaco();
      this.loadPromise = attempt;
      attempt.catch(() => {
        if (this.loadPromise === attempt) {
          this.loadPromise = null;
        }
      });
    }
    return this.loadPromise;
  }

  private async loadMonaco(): Promise<MonacoApi> {
    this.configureWorkers();
    const monaco = await import('monaco-editor');
    window.monaco = monaco as unknown as MonacoApi;
    return window.monaco;
  }

  private configureWorkers(): void {
    globalThis.MonacoEnvironment ??= {
      getWorker: (_moduleId: string, label: string) => {
        switch (label) {
          case 'json':
            return new Worker(new URL('./monaco-workers/json.worker', import.meta.url), {
              type: 'module',
            });
          case 'css':
          case 'scss':
          case 'less':
            return new Worker(new URL('./monaco-workers/css.worker', import.meta.url), {
              type: 'module',
            });
          case 'html':
          case 'handlebars':
          case 'razor':
            return new Worker(new URL('./monaco-workers/html.worker', import.meta.url), {
              type: 'module',
            });
          case 'typescript':
          case 'javascript':
            return new Worker(new URL('./monaco-workers/typescript.worker', import.meta.url), {
              type: 'module',
            });
          default:
            return new Worker(new URL('./monaco-workers/editor.worker', import.meta.url), {
              type: 'module',
            });
        }
      },
    } satisfies Environment;
  }
}
