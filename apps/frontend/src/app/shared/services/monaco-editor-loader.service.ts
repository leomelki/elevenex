import { Injectable } from '@angular/core';

type MonacoRequire = {
  config: (options: { paths: { vs: string } }) => void;
  (modules: string[], onLoad: () => void, onError?: (error: unknown) => void): void;
};

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
    setTheme(themeName: string): void;
  };
};

declare global {
  interface Window {
    monaco?: MonacoApi;
    require?: MonacoRequire;
  }
}

@Injectable({ providedIn: 'root' })
export class MonacoEditorLoaderService {
  private loadPromise: Promise<MonacoApi> | null = null;

  load(): Promise<MonacoApi> {
    if (window.monaco) {
      this.ensureStylesheet();
      return Promise.resolve(window.monaco);
    }

    this.ensureStylesheet();
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
    const vsBase = `${window.location.origin}/vs`;
    if (!window.require) {
      await this.loadScript(`${vsBase}/loader.js`);
    }

    return new Promise<MonacoApi>((resolve, reject) => {
      const require = window.require;
      if (!require) {
        reject(new Error('Monaco loader is unavailable.'));
        return;
      }

      require.config({ paths: { vs: vsBase } });
      require(
        ['vs/editor/editor.main'],
        () => {
          if (window.monaco) {
            resolve(window.monaco);
            return;
          }
          reject(new Error('Monaco editor did not initialize.'));
        },
        reject,
      );
    });
  }

  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset['loaded']) {
          resolve();
          return;
        }
        if (existing.dataset['error']) {
          reject(new Error(`Could not load ${src}`));
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.addEventListener('load', () => {
        script.dataset['loaded'] = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', () => {
        script.dataset['error'] = 'true';
        reject(new Error(`Could not load ${src}`));
      }, { once: true });
      document.head.appendChild(script);
    });
  }

  private ensureStylesheet(): void {
    const href = `${window.location.origin}/vs/editor/editor.main.css`;
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}
