import {
  MonacoEditorLoaderService,
  type MonacoApi,
  type MonacoEditorInstance,
  type MonacoEditorModel,
} from '@/shared/services/monaco-editor-loader.service';
import type { ConflictBlock } from '@/shared/utils/merge-conflicts';
import { DestroyRef, Injectable, inject } from '@angular/core';

let nextEditorId = 0;

/** Owns Monaco resources for one conflict panel; feature data stays in the host. */
@Injectable()
export class MergeConflictEditor {
  private readonly loader = inject(MonacoEditorLoaderService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly instanceId = ++nextEditorId;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly themeObserver = new MutationObserver(() => this.syncEditorTheme());
  private monaco: MonacoApi | null = null;
  private model: MonacoEditorModel | null = null;
  private decorations: string[] = [];
  private suppressEditorChange = false;
  private requestVersion = 0;
  private openFileKey: string | null = null;
  isOpen(worktreePath: string, path: string, content: string): boolean {
    return this.openFileKey === worktreePath + '\0' + path && this.model?.getValue() === content;
  }
  cancelPending(): void {
    this.requestVersion++;
  }
  private onContent: (content: string) => void = () => {};
  private onSelection: () => void = () => {};
  instance: MonacoEditorInstance | null = null;
  constructor() {
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    this.destroyRef.onDestroy(() => {
      this.themeObserver.disconnect();
      this.dispose();
    });
  }
  async open(
    host: HTMLElement,
    worktreePath: string,
    file: { path: string; content: string; language: string },
    onContent: (content: string) => void,
    onSelection: () => void,
  ): Promise<boolean> {
    const version = ++this.requestVersion;
    const monaco = await this.loader.load();
    if (version !== this.requestVersion || this.destroyRef.destroyed) return false;
    this.monaco = monaco;
    this.syncEditorTheme();
    this.onContent = onContent;
    this.onSelection = onSelection;
    const uri = monaco.Uri.parse(
      `inmemory://merge-conflicts/${this.instanceId}/${encodeURIComponent(worktreePath)}/${encodeURIComponent(file.path)}`,
    );
    const language = this.resolveEditorLanguage(monaco, file.path, file.language);
    const model =
      monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.content, language, uri);
    if (model.getValue() !== file.content) model.setValue(file.content);
    monaco.editor.setModelLanguage(model, language);
    if (!this.instance) {
      this.instance = monaco.editor.create(host, {
        model,
        automaticLayout: true,
        fontSize: 12,
        lineHeight: 20,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        lineNumbers: 'on',
        glyphMargin: true,
        readOnly: false,
        wordWrap: 'off',
      });
      this.disposables.push(
        this.instance.onDidChangeModelContent(() => {
          if (!this.suppressEditorChange) this.onContent(this.instance?.getValue() ?? '');
        }),
        this.instance.onDidChangeCursorSelection(() => this.onSelection()),
      );
    } else this.instance.setModel(model);
    if (this.model && this.model !== model) this.model.dispose();
    this.model = model;
    this.openFileKey = worktreePath + '\0' + file.path;
    this.instance.layout();
    return true;
  }

  private resolveEditorLanguage(monaco: MonacoApi, filePath: string, language: string): string {
    const registeredLanguages = monaco.languages.getLanguages();
    const requestedLanguage = language.trim() || 'plaintext';
    const requestedLanguageIsRegistered = registeredLanguages.some(
      (registered) => registered.id === requestedLanguage,
    );
    if (requestedLanguage !== 'plaintext' && requestedLanguageIsRegistered) {
      return requestedLanguage;
    }

    const basename = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
    const extensionStart = basename.lastIndexOf('.');
    const extension = extensionStart >= 0 ? basename.slice(extensionStart) : '';
    const matchedLanguage =
      registeredLanguages.find((registered) =>
        registered.filenames?.some((filename) => filename.toLowerCase() === basename),
      ) ??
      registeredLanguages.find((registered) =>
        extension
          ? registered.extensions?.some(
              (registeredExtension) => registeredExtension.toLowerCase() === extension,
            )
          : false,
      );

    return matchedLanguage?.id ?? (requestedLanguageIsRegistered ? requestedLanguage : 'plaintext');
  }

  setValue(value: string | null): void {
    if (!this.instance || value === null) return;
    this.suppressEditorChange = true;
    try {
      this.instance.setValue(value);
    } finally {
      this.suppressEditorChange = false;
    }
    this.onSelection();
  }

  decorate(blocks: readonly ConflictBlock[], active: ConflictBlock | null): void {
    if (!this.instance || !this.monaco) return;
    const decorations = blocks.flatMap((block) => {
      const isActive = active?.id === block.id;
      const className = isActive ? 'mc-editor-line--active-conflict' : 'mc-editor-line--conflict';
      const items: unknown[] = [
        {
          range: new this.monaco!.Range(block.startLine, 1, block.endLine, 1),
          options: {
            isWholeLine: true,
            className,
            glyphMarginClassName: 'mc-editor-glyph--conflict',
          },
        },
      ];
      if (block.ours.content.length) {
        items.push({
          range: new this.monaco!.Range(block.ours.startLine, 1, block.ours.endLine, 1),
          options: { isWholeLine: true, className: 'mc-editor-line--ours' },
        });
      }
      if (block.base?.content.length) {
        items.push({
          range: new this.monaco!.Range(block.base.startLine, 1, block.base.endLine, 1),
          options: { isWholeLine: true, className: 'mc-editor-line--base' },
        });
      }
      if (block.theirs.content.length) {
        items.push({
          range: new this.monaco!.Range(block.theirs.startLine, 1, block.theirs.endLine, 1),
          options: { isWholeLine: true, className: 'mc-editor-line--theirs' },
        });
      }
      return items;
    });
    this.decorations = this.instance.deltaDecorations(this.decorations, decorations);
  }

  private syncEditorTheme(): void {
    if (!this.monaco) return;
    this.monaco.editor.setTheme(
      document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    );
  }

  dispose(): void {
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    this.clearModel();
    this.instance?.dispose();
    this.instance = null;
  }

  clearModel(): void {
    this.requestVersion++;
    this.openFileKey = null;
    this.decorations = [];
    this.model?.dispose();
    this.model = null;
  }
}
