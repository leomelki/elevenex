import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitStatusSummary } from '@/shared/models/git.model';
import { FilesService } from '@/shared/services/files.service';
import { GitService } from '@/shared/services/git.service';
import { MonacoEditorLoaderService, MonacoSelection } from '@/shared/services/monaco-editor-loader.service';
import { MergeConflictsPanelComponent } from './merge-conflicts-panel.component';

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

const conflictedSummary = (files = ['src/a.ts']): GitStatusSummary => ({
  branch: 'feature',
  upstream: 'origin/feature',
  headSha: 'head123',
  worktreeFingerprint: 'fingerprint-a',
  ahead: 0,
  behind: 0,
  hasChanges: files.length > 0,
  files: files.map((path) => ({ path, status: 'conflicted' as const, staged: false })),
  staged: { files: 0, additions: 0, deletions: 0 },
  unstaged: { files: files.length, additions: 0, deletions: 0 },
  total: { files: files.length, additions: 0, deletions: 0 },
});

const conflictContent = [
  'before',
  '<<<<<<< HEAD',
  'current',
  '=======',
  'incoming',
  '>>>>>>> feature',
  'after',
  '',
].join('\n');

class FakeModel {
  disposed = false;

  constructor(private value: string) {}

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
  }

  getValueInRange(range: MonacoSelection): string {
    const lines = this.value.split(/\r?\n/);
    if (range.startLineNumber === range.endLineNumber) {
      return (lines[range.startLineNumber - 1] ?? '').slice(range.startColumn - 1, range.endColumn - 1);
    }
    return lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n');
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeEditor {
  selection: MonacoSelection | null = null;
  contentListeners: Array<() => void> = [];
  selectionListeners: Array<() => void> = [];

  constructor(private model: FakeModel) {}

  getValue(): string {
    return this.model.getValue();
  }

  setValue(value: string): void {
    this.model.setValue(value);
    this.contentListeners.forEach((listener) => listener());
  }

  getSelection(): MonacoSelection | null {
    return this.selection;
  }

  setSelection(selection: MonacoSelection): void {
    this.selection = selection;
    this.selectionListeners.forEach((listener) => listener());
  }

  revealLineInCenter(): void {}
  layout(): void {}
  focus(): void {}
  dispose(): void {}
  deltaDecorations(): string[] { return []; }
  getModel(): FakeModel { return this.model; }
  setModel(model: FakeModel): void { this.model = model; }

  onDidChangeModelContent(listener: () => void) {
    this.contentListeners.push(listener);
    return { dispose: () => undefined };
  }

  onDidChangeCursorSelection(listener: () => void) {
    this.selectionListeners.push(listener);
    return { dispose: () => undefined };
  }
}

describe('MergeConflictsPanelComponent', () => {
  let fixture: ComponentFixture<MergeConflictsPanelComponent>;
  let gitServiceMock: {
    getSummary: ReturnType<typeof vi.fn>;
    stageFiles: ReturnType<typeof vi.fn>;
  };
  let filesServiceMock: {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
  };
  let fakeEditor!: FakeEditor;

  beforeEach(async () => {
    const fakeMonaco = {
      Uri: { parse: (value: string) => value },
      Range: class {
        constructor(
          readonly startLineNumber: number,
          readonly startColumn: number,
          readonly endLineNumber: number,
          readonly endColumn: number,
        ) {}
      },
      editor: {
        create: (_element: HTMLElement, options: { model: FakeModel }) => {
          fakeEditor = new FakeEditor(options.model);
          return fakeEditor;
        },
        createModel: (value: string) => new FakeModel(value),
        getModel: () => null,
        setTheme: vi.fn(),
      },
    };

    gitServiceMock = {
      getSummary: vi.fn(() => of(conflictedSummary())),
      stageFiles: vi.fn(() => of(undefined)),
    };
    filesServiceMock = {
      readFile: vi.fn(() => of({ content: conflictContent, language: 'typescript' })),
      writeFile: vi.fn(() => of({ success: true })),
    };

    await TestBed.configureTestingModule({
      imports: [MergeConflictsPanelComponent],
      providers: [
        { provide: GitService, useValue: gitServiceMock },
        { provide: FilesService, useValue: filesServiceMock },
        { provide: MonacoEditorLoaderService, useValue: { load: vi.fn(() => Promise.resolve(fakeMonaco)) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MergeConflictsPanelComponent);
    fixture.componentRef.setInput('worktreePath', '/tmp/repo');
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  });

  it('loads only conflicted files and their conflict blocks', () => {
    expect(gitServiceMock.getSummary).toHaveBeenCalledWith('/tmp/repo', { conflictsOnly: true });
    expect(filesServiceMock.readFile).toHaveBeenCalledWith('/tmp/repo', 'src/a.ts');
    expect(fixture.componentInstance.conflictedFiles()).toHaveLength(1);
    expect(fixture.componentInstance.activeBlocks()).toHaveLength(1);
  });

  it('blocks resolving while conflict markers remain', async () => {
    await fixture.componentInstance.markResolved();

    expect(gitServiceMock.stageFiles).not.toHaveBeenCalled();
  });

  it('saves edits before marking a marker-free file resolved', async () => {
    gitServiceMock.getSummary
      .mockReturnValueOnce(of(conflictedSummary()))
      .mockReturnValueOnce(of(conflictedSummary([])));

    fixture.componentInstance.accept('current');
    await fixture.componentInstance.markResolved();

    expect(filesServiceMock.writeFile).toHaveBeenCalledWith('/tmp/repo', 'src/a.ts', 'before\ncurrent\nafter\n');
    expect(gitServiceMock.stageFiles).toHaveBeenCalledWith('/tmp/repo', ['src/a.ts']);
  });

  it('emits a conflict mention for the editor selection', () => {
    const emitted: unknown[] = [];
    fixture.componentInstance.mentionSelection.subscribe((mentions) => emitted.push(mentions));

    fakeEditor.setSelection({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 8,
    });
    fixture.detectChanges();
    fixture.componentInstance.mentionCurrentSelection();

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as any[])[0]).toMatchObject({
      scope: 'conflicts',
      status: 'conflicted',
      filePath: 'src/a.ts',
      selectedText: 'current',
      newLineStart: 3,
      newLineEnd: 3,
    });
  });
});
