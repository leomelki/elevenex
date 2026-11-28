import * as vscode from 'vscode';
import type { DirectoryPage, FileRead } from './contracts';
import { LINKED_FILES_VIEW, type CompactLayout } from './compact-layout';

const SCHEME = 'elevenex-link';
type Read = <T>(operation: string, input: object) => Promise<T>;

interface LinkedEntry {
  readonly uri: vscode.Uri;
  readonly type: vscode.FileType;
  readonly parent?: LinkedEntry;
  readonly after?: string;
}

class LinkedFiles implements vscode.FileSystemProvider, vscode.TreeDataProvider<LinkedEntry>, vscode.Disposable {
  private readonly filesChanged = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly treeChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeFile = this.filesChanged.event;
  readonly onDidChangeTreeData = this.treeChanged.event;
  private root?: LinkedEntry;
  constructor(private readonly read: Read) {}
  dispose(): void { this.filesChanged.dispose(); this.treeChanged.dispose(); }
  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions(); }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }
  private address(uri: vscode.Uri) {
    const parts = /^\/[^/]+(\/.*)?$/.exec(uri.path);
    if (uri.scheme !== SCHEME || !/^[a-f0-9-]{36}$/.test(uri.authority) || !parts || uri.query || uri.fragment)
      throw vscode.FileSystemError.FileNotFound(uri);
    return { id: uri.authority, path: parts[1] ?? '/' };
  }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const stat = await this.read<vscode.FileStat>('link-stat', this.address(uri));
    return { ...stat, permissions: vscode.FilePermission.Readonly };
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { content } = await this.read<FileRead>('link-read', this.address(uri));
    return Uint8Array.from(atob(content), character => character.charCodeAt(0));
  }
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const result: [string, vscode.FileType][] = [];
    let after: string | null = null;
    do {
      const page: DirectoryPage = await this.read('link-directory', { ...this.address(uri), after: after ?? undefined });
      result.push(...page.entries.map(({ name, type }): [string, vscode.FileType] => [name, type]));
      after = page.next;
    } while (after && result.length < 10_000);
    return result;
  }
  selectFolder(uri: vscode.Uri): LinkedEntry {
    this.root = { uri, type: vscode.FileType.Directory };
    this.treeChanged.fire();
    return this.root;
  }
  getParent(entry: LinkedEntry): LinkedEntry | undefined { return entry.parent; }
  async getChildren(entry?: LinkedEntry): Promise<LinkedEntry[]> {
    if (!entry) return this.root ? [this.root] : [];
    const page = await this.read<DirectoryPage>('link-directory', { ...this.address(entry.uri), after: entry.after });
    const entries: LinkedEntry[] = page.entries.map(({ name, type }) => ({ uri: vscode.Uri.joinPath(entry.uri, name), type, parent: entry }));
    if (page.next) entries.push({ uri: entry.uri, type: vscode.FileType.Directory, parent: entry, after: page.next });
    return entries;
  }
  getTreeItem(entry: LinkedEntry): vscode.TreeItem {
    const folder = entry.type === vscode.FileType.Directory;
    const state = folder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = entry.after ? new vscode.TreeItem('More entries', state) : new vscode.TreeItem(entry.uri, state);
    item.id = entry.uri.toString() + (entry.after ? '#' + encodeURIComponent(entry.after) : '');
    if (!entry.after) item.iconPath = folder ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    if (!folder) item.command = { command: 'elevenex.code.open-linked-entry', title: 'Open linked file', arguments: [entry.uri] };
    return item;
  }
}

export async function openEditorResource(layout: CompactLayout, uri: vscode.Uri, line: number, column: number): Promise<void> {
  await layout.revealEditor();
  await vscode.commands.executeCommand('vscode.open', uri, {
    preview: false, selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1),
  } satisfies vscode.TextDocumentShowOptions);
}

export function registerLinkedFiles(context: vscode.ExtensionContext, layout: CompactLayout, read: Read): void {
  const files = new LinkedFiles(read);
  const view = vscode.window.createTreeView(LINKED_FILES_VIEW, { treeDataProvider: files, showCollapseAll: true });
  context.subscriptions.push(files, view, vscode.workspace.registerFileSystemProvider(SCHEME, files, { isReadonly: true, isCaseSensitive: true }),
    vscode.commands.registerCommand('elevenex.code.open-link', async (id: unknown, name: unknown, type: unknown, line: unknown, column: unknown) => {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..' ||
          typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1)
        throw new Error('Invalid linked resource.');
      const uri = vscode.Uri.from({ scheme: SCHEME, authority: id, path: '/' + name });
      const stat = await files.stat(uri);
      if (stat.type !== type) throw vscode.FileSystemError.FileNotFound(uri);
      if (type === vscode.FileType.Directory) {
        const root = files.selectFolder(uri);
        await vscode.commands.executeCommand('setContext', 'elevenex.hasLinkedFolder', true);
        await layout.browse(LINKED_FILES_VIEW);
        await view.reveal(root, { select: true, focus: true, expand: true });
      } else {
        await openEditorResource(layout, uri, line, column);
      }
    }),
    vscode.commands.registerCommand('elevenex.code.open-linked-entry', async (uri: vscode.Uri) => {
      const stat = await files.stat(uri);
      if (stat.type === vscode.FileType.File) await openEditorResource(layout, uri, 1, 1);
    }),
  );
}
