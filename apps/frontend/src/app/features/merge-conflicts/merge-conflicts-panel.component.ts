import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronDown,
  lucideChevronUp,
  lucideFileCode,
  lucideGitBranch,
  lucideGitMerge,
  lucideLoader,
  lucideMessageSquarePlus,
  lucideRefreshCw,
  lucideRotateCcw,
  lucideSave,
  lucideSearch,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import { FileStatus, GitStatusSummary } from '@/shared/models/git.model';
import { FilesService } from '@/shared/services/files.service';
import { GitService } from '@/shared/services/git.service';
import {
  MonacoApi,
  MonacoEditorInstance,
  MonacoEditorLoaderService,
  MonacoEditorModel,
  MonacoSelection,
} from '@/shared/services/monaco-editor-loader.service';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import {
  ConflictBlock,
  ConflictResolutionStrategy,
  applyConflictResolution,
  parseConflictBlocks,
} from '@/shared/utils/merge-conflicts';

interface ConflictFileState {
  file: FileStatus;
  content: string | null;
  savedContent: string | null;
  language: string;
  loading: boolean;
  saving: boolean;
  resolving: boolean;
  dirty: boolean;
  unsupported: boolean;
  error: string | null;
  blocks: ConflictBlock[];
}

interface PendingMention {
  mention: DiffSelectionMention;
}

@Component({
  selector: 'app-merge-conflicts-panel',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  templateUrl: './merge-conflicts-panel.component.html',
  styleUrl: './merge-conflicts-panel.component.scss',
  host: { class: 'block h-full min-h-0 bg-background text-foreground' },
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronDown,
      lucideChevronUp,
      lucideFileCode,
      lucideGitBranch,
      lucideGitMerge,
      lucideLoader,
      lucideMessageSquarePlus,
      lucideRefreshCw,
      lucideRotateCcw,
      lucideSave,
      lucideSearch,
      lucideTriangleAlert,
    }),
  ],
})
export class MergeConflictsPanelComponent implements OnDestroy {
  readonly worktreePath = input.required<string>();
  readonly mentionSelection = output<DiffSelectionMention[]>();

  private readonly gitService = inject(GitService);
  private readonly filesService = inject(FilesService);
  private readonly monacoLoader = inject(MonacoEditorLoaderService);
  private readonly editorHost = viewChild<ElementRef<HTMLElement>>('editorHost');
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly themeObserver = new MutationObserver(() => this.syncEditorTheme());

  private monaco: MonacoApi | null = null;
  private editor: MonacoEditorInstance | null = null;
  private model: MonacoEditorModel | null = null;
  private editorPath: string | null = null;
  private decorations: string[] = [];
  private requestGeneration = 0;
  private suppressEditorChange = false;

  readonly summary = signal<GitStatusSummary | null>(null);
  readonly loadingSummary = signal(false);
  readonly error = signal<string | null>(null);
  readonly search = signal('');
  readonly fileStates = signal<ReadonlyMap<string, ConflictFileState>>(new Map());
  readonly activeFilePath = signal<string | null>(null);
  readonly activeConflictIndex = signal(0);
  readonly pendingMention = signal<PendingMention | null>(null);

  readonly conflictedFiles = computed(() => {
    const query = this.search().trim().toLowerCase();
    const files = this.summary()?.files.filter((file) => file.status === 'conflicted') ?? [];
    if (!query) return files;
    return files.filter((file) => file.path.toLowerCase().includes(query));
  });

  readonly activeState = computed(() => {
    const activePath = this.activeFilePath();
    return activePath ? this.fileStates().get(activePath) ?? null : null;
  });

  readonly activeBlocks = computed(() => this.activeState()?.blocks ?? []);
  readonly activeConflict = computed(() => this.activeBlocks()[this.activeConflictIndex()] ?? null);
  readonly dirtyCount = computed(() => [...this.fileStates().values()].filter((state) => state.dirty).length);
  readonly resolvedLoadedCount = computed(() => [...this.fileStates().values()].filter((state) => state.content !== null && state.blocks.length === 0).length);

  constructor() {
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    effect(() => {
      const worktreePath = this.worktreePath();
      if (!worktreePath) return;
      void this.loadSummary(true);
    });

    effect(() => {
      const activePath = this.activeFilePath();
      if (!activePath) return;
      const state = this.fileStates().get(activePath);
      if (!state || state.loading || state.content !== null || state.unsupported) return;
      void this.loadFile(activePath, false);
    });
  }

  ngOnDestroy(): void {
    this.requestGeneration += 1;
    this.themeObserver.disconnect();
    this.disposeEditor();
  }

  setSearch(value: string): void {
    this.search.set(value);
    const activePath = this.activeFilePath();
    const files = this.conflictedFiles();
    if (!activePath || !files.some((file) => file.path === activePath)) {
      this.selectFile(files[0]?.path ?? null);
    }
  }

  async refresh(): Promise<void> {
    await this.loadSummary(true);
  }

  selectFile(path: string | null): void {
    this.pendingMention.set(null);
    this.activeConflictIndex.set(0);
    this.activeFilePath.set(path);
    if (path) {
      void this.loadFile(path, false);
    } else {
      this.disposeActiveModel();
    }
  }

  async saveActive(): Promise<boolean> {
    const state = this.activeState();
    if (!state || state.content === null || state.unsupported || state.saving) return false;
    return this.saveFile(state.file.path);
  }

  async discardActive(): Promise<void> {
    const state = this.activeState();
    if (!state || state.savedContent === null) return;
    this.updateFileState(state.file.path, (current) => ({
      ...current,
      content: current.savedContent,
      dirty: false,
      blocks: parseConflictBlocks(current.savedContent ?? ''),
      error: null,
    }));
    if (this.activeFilePath() === state.file.path) {
      this.setEditorValue(state.savedContent);
      this.redecorate();
    }
  }

  async markResolved(): Promise<void> {
    const state = this.activeState();
    if (!state || state.content === null || state.unsupported || state.resolving) return;

    if (state.dirty && !(await this.saveFile(state.file.path))) {
      return;
    }

    const currentContent = this.currentEditorContent(state);
    if (parseConflictBlocks(currentContent).length > 0) {
      toast.error('Resolve all conflict markers before marking this file resolved.');
      return;
    }

    this.updateFileState(state.file.path, (current) => ({ ...current, resolving: true }));
    try {
      await firstValueFrom(this.gitService.stageFiles(this.worktreePath(), [state.file.path]));
      toast.success('Marked file as resolved');
      await this.loadSummary(false);
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not mark file resolved.');
    } finally {
      this.updateFileState(state.file.path, (current) => ({ ...current, resolving: false }));
    }
  }

  accept(strategy: ConflictResolutionStrategy): void {
    const state = this.activeState();
    const block = this.activeConflict();
    const editor = this.editor;
    if (!state || !block || !editor) return;

    const next = applyConflictResolution(editor.getValue(), block, strategy);
    const revealLine = block.startLine;
    this.setEditorValue(next);
    this.updateContentFromEditor(state.file.path, next);
    const blocks = this.activeBlocks();
    this.activeConflictIndex.set(Math.min(this.activeConflictIndex(), Math.max(0, blocks.length - 1)));
    window.setTimeout(() => {
      editor.revealLineInCenter(Math.min(revealLine, Math.max(1, next.split(/\r?\n/).length)));
      editor.focus();
    }, 0);
  }

  previousConflict(): void {
    const count = this.activeBlocks().length;
    if (count === 0) return;
    const next = (this.activeConflictIndex() - 1 + count) % count;
    this.activeConflictIndex.set(next);
    this.revealActiveConflict();
  }

  nextConflict(): void {
    const count = this.activeBlocks().length;
    if (count === 0) return;
    const next = (this.activeConflictIndex() + 1) % count;
    this.activeConflictIndex.set(next);
    this.revealActiveConflict();
  }

  mentionCurrentSelection(): void {
    const pending = this.pendingMention();
    if (!pending) return;
    this.mentionSelection.emit([pending.mention]);
    this.pendingMention.set(null);
    toast.success('Added conflict selection to chat');
  }

  fileBasename(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  fileDirname(filePath: string): string {
    const parts = filePath.split('/');
    parts.pop();
    return parts.join('/');
  }

  isSelected(file: FileStatus): boolean {
    return this.activeFilePath() === file.path;
  }

  stateFor(file: FileStatus): ConflictFileState | null {
    return this.fileStates().get(file.path) ?? null;
  }

  trackFile(index: number, file: FileStatus): string {
    return `${file.path}:${file.status}`;
  }

  async loadFile(path: string, force: boolean): Promise<void> {
    const state = this.fileStates().get(path);
    if (!state || state.loading || state.unsupported && !force) return;
    if (!force && state.content !== null) {
      await this.ensureEditorForActive();
      return;
    }

    const generation = this.requestGeneration;
    this.updateFileState(path, (current) => ({ ...current, loading: true, error: null }));
    try {
      const file = await firstValueFrom(this.filesService.readFile(this.worktreePath(), path));
      if (generation !== this.requestGeneration) return;
      const unsupported = file.content.includes('\0');
      this.updateFileState(path, (current) => ({
        ...current,
        content: unsupported ? null : file.content,
        savedContent: unsupported ? null : file.content,
        language: file.language || 'plaintext',
        loading: false,
        dirty: false,
        unsupported,
        error: unsupported ? 'Binary conflicted files cannot be edited here.' : null,
        blocks: unsupported ? [] : parseConflictBlocks(file.content),
      }));
      if (this.activeFilePath() === path) {
        await this.ensureEditorForActive();
      }
    } catch (error: any) {
      if (generation !== this.requestGeneration) return;
      this.updateFileState(path, (current) => ({
        ...current,
        loading: false,
        error: error?.error?.message || 'Could not load file.',
      }));
    }
  }

  private async loadSummary(clearDrafts: boolean): Promise<void> {
    const worktreePath = this.worktreePath();
    const generation = ++this.requestGeneration;
    this.loadingSummary.set(true);
    this.error.set(null);
    this.pendingMention.set(null);
    if (clearDrafts) {
      this.disposeActiveModel();
      this.fileStates.set(new Map());
    }

    try {
      const summary = await firstValueFrom(this.gitService.getSummary(worktreePath));
      if (generation !== this.requestGeneration) return;
      const conflictFiles = summary.files.filter((file) => file.status === 'conflicted');
      const previous = clearDrafts ? new Map<string, ConflictFileState>() : this.fileStates();
      this.summary.set(summary);
      this.fileStates.set(new Map(conflictFiles.map((file) => [
        file.path,
        this.mergeFileState(file, previous.get(file.path) ?? null, clearDrafts),
      ])));

      const activePath = this.activeFilePath();
      const nextActive = activePath && conflictFiles.some((file) => file.path === activePath)
        ? activePath
        : conflictFiles[0]?.path ?? null;
      this.selectFile(nextActive);
    } catch (error: any) {
      if (generation !== this.requestGeneration) return;
      const message = error?.error?.message || 'Could not load conflicted files.';
      this.error.set(message);
      toast.error(message);
    } finally {
      if (generation === this.requestGeneration) {
        this.loadingSummary.set(false);
      }
    }
  }

  private mergeFileState(
    file: FileStatus,
    previous: ConflictFileState | null,
    clearDrafts: boolean,
  ): ConflictFileState {
    if (previous && !clearDrafts) {
      return { ...previous, file };
    }

    return {
      file,
      content: null,
      savedContent: null,
      language: 'plaintext',
      loading: false,
      saving: false,
      resolving: false,
      dirty: false,
      unsupported: false,
      error: null,
      blocks: [],
    };
  }

  private async saveFile(path: string): Promise<boolean> {
    const state = this.fileStates().get(path);
    if (!state || state.content === null || state.unsupported) return false;
    const content = this.activeFilePath() === path ? this.currentEditorContent(state) : state.content;

    this.updateFileState(path, (current) => ({ ...current, saving: true, error: null }));
    try {
      await firstValueFrom(this.filesService.writeFile(this.worktreePath(), path, content));
      this.updateFileState(path, (current) => ({
        ...current,
        content,
        savedContent: content,
        dirty: false,
        saving: false,
        blocks: parseConflictBlocks(content),
      }));
      toast.success('Saved file');
      return true;
    } catch (error: any) {
      this.updateFileState(path, (current) => ({
        ...current,
        saving: false,
        error: error?.error?.message || 'Could not save file.',
      }));
      toast.error(error?.error?.message || 'Could not save file.');
      return false;
    }
  }

  private async ensureEditorForActive(): Promise<void> {
    const host = this.editorHost()?.nativeElement;
    const state = this.activeState();
    if (!state || state.content === null || state.unsupported) {
      this.disposeActiveModel();
      return;
    }
    if (!host) {
      window.setTimeout(() => void this.ensureEditorForActive(), 0);
      return;
    }
    const activePath = state.file.path;

    const monaco = await this.monacoLoader.load();
    if (this.activeFilePath() !== activePath) return;
    this.monaco = monaco;
    this.syncEditorTheme();

    const uri = monaco.Uri.parse(`inmemory://merge-conflicts/${encodeURIComponent(this.worktreePath())}/${encodeURIComponent(state.file.path)}`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(state.content, state.language, uri);
    if (model.getValue() !== state.content) {
      model.setValue(state.content);
    }

    if (!this.editor) {
      this.editor = monaco.editor.create(host, {
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
        this.editor.onDidChangeModelContent(() => {
          if (this.suppressEditorChange) return;
          const activePath = this.activeFilePath();
          if (activePath) {
            this.updateContentFromEditor(activePath, this.editor?.getValue() ?? '');
          }
        }),
        this.editor.onDidChangeCursorSelection(() => this.updatePendingMention()),
      );
    } else {
      this.editor.setModel(model);
    }

    if (this.model && this.model !== model) {
      this.model.dispose();
    }
    this.model = model;
    this.editorPath = state.file.path;
    this.redecorate();
    this.revealActiveConflict();
    window.setTimeout(() => this.editor?.layout(), 0);
  }

  private setEditorValue(value: string | null): void {
    if (!this.editor || value === null) return;
    this.suppressEditorChange = true;
    try {
      this.editor.setValue(value);
    } finally {
      this.suppressEditorChange = false;
    }
    this.updatePendingMention();
  }

  private currentEditorContent(state: ConflictFileState): string {
    return this.activeFilePath() === state.file.path && this.editor
      ? this.editor.getValue()
      : state.content ?? '';
  }

  private updateContentFromEditor(path: string, content: string): void {
    this.updateFileState(path, (state) => {
      const blocks = parseConflictBlocks(content);
      return {
        ...state,
        content,
        dirty: content !== (state.savedContent ?? ''),
        blocks,
      };
    });
    const blocks = this.activeBlocks();
    if (this.activeConflictIndex() >= blocks.length) {
      this.activeConflictIndex.set(Math.max(0, blocks.length - 1));
    }
    this.redecorate();
    this.updatePendingMention();
  }

  private updatePendingMention(): void {
    const state = this.activeState();
    const editor = this.editor;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    if (!state || !editor || !model || !selection || isSelectionEmpty(selection)) {
      this.pendingMention.set(null);
      return;
    }

    const selectedText = model.getValueInRange(selection).trim();
    if (!selectedText) {
      this.pendingMention.set(null);
      return;
    }

    const startLine = Math.min(selection.startLineNumber, selection.endLineNumber);
    const endLine = Math.max(selection.startLineNumber, selection.endLineNumber);
    const mention: DiffSelectionMention = {
      id: `conflict-mention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      version: 1,
      scope: 'conflicts',
      compareLabel: 'Merge conflicts',
      baseSha: null,
      headSha: this.summary()?.headSha ?? null,
      filePath: state.file.path,
      oldPath: state.file.oldPath ?? null,
      status: 'conflicted',
      changeHash: this.summary()?.worktreeFingerprint ?? null,
      oldLineStart: null,
      oldLineEnd: null,
      newLineStart: startLine,
      newLineEnd: endLine,
      selectedText,
      context: this.contextForSelection(state.content ?? '', startLine, endLine),
      truncated: false,
    };
    this.pendingMention.set({ mention });
  }

  private contextForSelection(content: string, startLine: number, endLine: number): DiffSelectionMention['context'] {
    const lines = splitLines(content);
    const row = (line: string, index: number) => ({
      type: 'context' as const,
      oldLine: null,
      newLine: index + 1,
      content: line,
    });
    return {
      before: lines.slice(Math.max(0, startLine - 4), startLine - 1).map(row),
      selected: lines.slice(startLine - 1, endLine).map((line, index) => row(line, startLine - 1 + index)),
      after: lines.slice(endLine, endLine + 3).map(row),
    };
  }

  private redecorate(): void {
    if (!this.editor || !this.monaco) return;
    const active = this.activeConflict();
    const decorations = this.activeBlocks().flatMap((block) => {
      const isActive = active?.id === block.id;
      const className = isActive ? 'mc-editor-line--active-conflict' : 'mc-editor-line--conflict';
      const items: unknown[] = [{
        range: new this.monaco!.Range(block.startLine, 1, block.endLine, 1),
        options: { isWholeLine: true, className, glyphMarginClassName: 'mc-editor-glyph--conflict' },
      }];
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
    this.decorations = this.editor.deltaDecorations(this.decorations, decorations);
  }

  private revealActiveConflict(): void {
    const block = this.activeConflict();
    if (!block || !this.editor) return;
    this.editor.revealLineInCenter(block.startLine);
    this.redecorate();
  }

  private syncEditorTheme(): void {
    if (!this.monaco) return;
    this.monaco.editor.setTheme(document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs');
  }

  private updateFileState(
    path: string,
    updater: (state: ConflictFileState) => ConflictFileState,
  ): void {
    this.fileStates.update((current) => {
      const state = current.get(path);
      if (!state) return current;
      const nextState = updater(state);
      const next = new Map(current);
      next.set(path, nextState);
      return next;
    });
  }

  private disposeEditor(): void {
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    this.disposeActiveModel();
    this.editor?.dispose();
    this.editor = null;
  }

  private disposeActiveModel(): void {
    this.decorations = [];
    this.editorPath = null;
    this.model?.dispose();
    this.model = null;
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.editor?.layout();
  }
}

function isSelectionEmpty(selection: MonacoSelection): boolean {
  return selection.startLineNumber === selection.endLineNumber
    && selection.startColumn === selection.endColumn;
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (content.endsWith('\n')) lines.pop();
  return lines;
}
