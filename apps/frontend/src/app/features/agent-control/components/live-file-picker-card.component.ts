import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpRight,
  lucideCheck,
  lucideChevronLeft,
  lucideFile,
  lucideFolder,
  lucideFolderOpen,
  lucideFolderSearch,
  lucideLoaderCircle,
  lucideSparkles,
  lucideType,
  lucideX,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardCheckboxComponent } from '@/shared/components/checkbox/checkbox.component';
import { ZardInputDirective } from '@/shared/components/input';
import { ZardTreeComponent, type TreeNode } from '@/shared/components/tree';
import { FilesService, type FileTreeNode } from '@/shared/services/files.service';

import type {
  AgentLiveSelection,
  AgentSelectionResolution,
} from '../agent-channel-websocket.service';

/** Data payload carried on each tree node (mirrors the backend file listing). */
interface FileNodeData {
  type: 'file' | 'directory';
  /** Path relative to the request's `rootPath`. */
  path: string;
}

type FileNode = TreeNode<FileNodeData>;

/**
 * Interactive file/folder picker for a single live `select_paths` request from
 * the meta-agent. Reuses the shared `z-tree` for browsing (lazy-loading each
 * directory on expand) and lets the human answer in one of four ways:
 *   • pick one or more paths and confirm,
 *   • reply with free text (a hint / a path to use),
 *   • hand the decision back to the agent ("let the agent decide"),
 *   • dismiss (cancel).
 * The chosen outcome is emitted via `resolve` for the drawer to send back.
 */
@Component({
  selector: 'app-live-file-picker-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NgIcon,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputDirective,
    ZardTreeComponent,
  ],
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
      lucideCheck,
      lucideChevronLeft,
      lucideFile,
      lucideFolder,
      lucideFolderOpen,
      lucideFolderSearch,
      lucideLoaderCircle,
      lucideSparkles,
      lucideType,
      lucideX,
    }),
  ],
  templateUrl: './live-file-picker-card.component.html',
  styleUrl: './live-file-picker-card.component.scss',
})
export class LiveFilePickerCardComponent {
  private readonly files = inject(FilesService);

  readonly selection = input.required<AgentLiveSelection>();
  readonly resolve = output<AgentSelectionResolution>();
  readonly open = output<string>();

  /** Root-level tree nodes; children are filled in lazily on expand. */
  protected readonly treeData = signal<FileNode[]>([]);
  /** Selected entries, keyed by relative path → entry type. */
  protected readonly selected = signal<Map<string, 'file' | 'directory'>>(new Map());
  /** Keys of directories currently expanded (drives the open/closed icon). */
  protected readonly expandedKeys = signal<Set<string>>(new Set());
  /** Keys of directories with an in-flight children fetch. */
  protected readonly loadingKeys = signal<Set<string>>(new Set());

  protected readonly loadingRoot = signal(true);
  protected readonly errorMessage = signal<string | null>(null);
  /** `browse` shows the tree; `text` shows the free-text reply box. */
  protected readonly mode = signal<'browse' | 'text'>('browse');
  protected readonly textDraft = signal('');

  /** Directories whose children have already been fetched (empty ≠ unloaded). */
  private readonly loadedKeys = new Set<string>();
  private currentRoot = '';

  protected readonly selectedList = computed(() =>
    [...this.selected().entries()].map(([path, type]) => ({ path, type })),
  );
  protected readonly canConfirm = computed(() => this.selected().size > 0);
  protected readonly canSubmitText = computed(() => this.textDraft().trim().length > 0);

  protected readonly kindLabel = computed(() => {
    switch (this.selection().selectionKind) {
      case 'file':
        return this.selection().multiple ? 'files' : 'a file';
      case 'folder':
        return this.selection().multiple ? 'folders' : 'a folder';
      default:
        return this.selection().multiple ? 'files or folders' : 'a file or folder';
    }
  });

  constructor() {
    // Load (or reload) the root listing whenever the target root changes. Reading
    // the required input inside an effect defers it past construction safely.
    effect(() => {
      const root = this.selection().rootPath;
      if (root && root !== this.currentRoot) {
        this.currentRoot = root;
        untracked(() => this.loadRoot(root));
      }
    });
  }

  // --- Selection ---------------------------------------------------------

  protected isSelectable(node: FileNode): boolean {
    const kind = this.selection().selectionKind;
    const type = node.data?.type;
    if (kind === 'file') return type === 'file';
    if (kind === 'folder') return type === 'directory';
    return true;
  }

  protected isSelected(key: string): boolean {
    return this.selected().has(key);
  }

  protected toggleSelect(node: FileNode): void {
    if (!this.isSelectable(node) || !node.data) return;
    const key = node.key;
    const type = node.data.type;
    this.selected.update((current) => {
      const next = new Map(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (!this.selection().multiple) next.clear();
        next.set(key, type);
      }
      return next;
    });
  }

  protected removeSelected(path: string): void {
    this.selected.update((current) => {
      const next = new Map(current);
      next.delete(path);
      return next;
    });
  }

  protected basename(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }

  // --- Tree interactions -------------------------------------------------

  protected onNodeClick(node: FileNode): void {
    // Row clicks select files; directories are toggled/expanded by the tree and
    // selected (in folder mode) via their explicit checkbox only.
    if (node.leaf) this.toggleSelect(node);
  }

  protected onExpand(node: FileNode): void {
    this.expandedKeys.update((keys) => new Set(keys).add(node.key));
    if (node.data?.type === 'directory' && !this.loadedKeys.has(node.key)) {
      this.loadChildren(node);
    }
  }

  protected onCollapse(node: FileNode): void {
    this.expandedKeys.update((keys) => {
      const next = new Set(keys);
      next.delete(node.key);
      return next;
    });
  }

  protected isExpanded(key: string): boolean {
    return this.expandedKeys().has(key);
  }

  protected isLoading(key: string): boolean {
    return this.loadingKeys().has(key);
  }

  // --- Outcomes ----------------------------------------------------------

  protected confirm(): void {
    if (!this.canConfirm()) return;
    this.resolve.emit({
      id: this.selection().id,
      outcome: 'selected',
      paths: this.selectedList().map((item) => ({
        path: item.path,
        type: item.type,
      })),
    });
  }

  protected submitText(): void {
    if (!this.canSubmitText()) return;
    this.resolve.emit({
      id: this.selection().id,
      outcome: 'text',
      text: this.textDraft().trim(),
    });
  }

  protected defer(): void {
    this.resolve.emit({ id: this.selection().id, outcome: 'defer' });
  }

  protected cancel(): void {
    this.resolve.emit({ id: this.selection().id, outcome: 'cancelled' });
  }

  protected onOpen(): void {
    const deepLink = this.selection().deepLink;
    if (deepLink) this.open.emit(deepLink);
  }

  protected showText(): void {
    this.mode.set('text');
  }

  protected showBrowse(): void {
    this.mode.set('browse');
  }

  protected onTextInput(event: Event): void {
    this.textDraft.set((event.target as HTMLTextAreaElement).value);
  }

  // --- Data loading ------------------------------------------------------

  private loadRoot(root: string): void {
    this.loadingRoot.set(true);
    this.errorMessage.set(null);
    this.loadedKeys.clear();
    this.files.listFiles(root).subscribe({
      next: (nodes) => {
        this.treeData.set(nodes as FileNode[]);
        this.loadingRoot.set(false);
      },
      error: (error: unknown) => {
        this.errorMessage.set(this.errorText(error));
        this.loadingRoot.set(false);
      },
    });
  }

  private loadChildren(node: FileNode): void {
    if (!node.data || this.loadingKeys().has(node.key)) return;
    this.addLoading(node.key);
    this.files.listFiles(this.currentRoot, node.data.path).subscribe({
      next: (children: FileTreeNode[]) => {
        this.loadedKeys.add(node.key);
        this.setChildren(node.key, children as FileNode[]);
        this.removeLoading(node.key);
      },
      error: () => {
        this.removeLoading(node.key);
      },
    });
  }

  /**
   * Immutably attach `children` to the node with `key`, cloning every node on
   * the path down to it. New object references are required so the OnPush
   * `z-tree-node` for the target (and its ancestors) actually re-renders.
   */
  private setChildren(key: string, children: FileNode[]): void {
    const replace = (nodes: FileNode[]): FileNode[] =>
      nodes.map((node) => {
        if (node.key === key) {
          return { ...node, children };
        }
        // Only recurse into the branch that contains the target key.
        if (node.children?.length && key.startsWith(`${node.key}/`)) {
          return { ...node, children: replace(node.children) };
        }
        return node;
      });
    this.treeData.update((nodes) => replace(nodes));
  }

  private addLoading(key: string): void {
    this.loadingKeys.update((keys) => new Set(keys).add(key));
  }

  private removeLoading(key: string): void {
    this.loadingKeys.update((keys) => {
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
  }

  private errorText(error: unknown): string {
    const message =
      (error as { error?: { message?: string } })?.error?.message ??
      (error as { message?: string })?.message;
    return message ?? 'Could not read that folder.';
  }
}
