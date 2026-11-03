import * as vscode from 'vscode';

const STORAGE_KEY = 'elevenex.compact-layout';
const FILE_VIEW = 'workbench.explorer.fileView';
const FILE_CONTAINER = 'workbench.view.extension.elevenex-files';
const SETTINGS = [
  { key: 'workbench.activityBar.location', value: 'hidden' },
  { key: 'editor.wordWrap', value: 'on' },
] as const;
interface SavedSetting { readonly key: string; readonly value?: unknown }

/** The genuine Explorer temporarily occupies the compact workbench. Native
 * maximization hides, never closes, editors. The same file view moves back to
 * Explorer on expansion, retaining its tree state and bounded file provider. */
export class CompactLayout implements vscode.Disposable {
  private compact?: boolean;
  private browsing = false;
  private moved = false;
  private stopped = false;
  private applying = false;
  private activeTab: vscode.Tab | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly state: vscode.Memento, private readonly present: (filesOpen: boolean, hasEditors: boolean) => Promise<unknown> = async () => undefined) {
    this.activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    this.subscriptions = [
      vscode.window.tabGroups.onDidChangeTabs(event => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        const selected = event.opened.length > 0 || active !== this.activeTab;
        this.activeTab = active;
        void this.run(() => this.reconcile(selected)).catch(() => undefined);
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        // Focusing the tree can clear activeTextEditor. Tab groups, rather than
        // focus, define whether there is an editor to return to.
        if (editor && !this.applying && this.browsing) void this.run(() => this.reconcile(true)).catch(() => undefined);
      }),
    ];
  }
  dispose(): void { this.stopped = true; for (const subscription of this.subscriptions) subscription.dispose(); }
  set(compact: boolean): Promise<void> { return this.run(() => this.setMode(compact)); }
  browse(): Promise<void> { return this.run(async () => {
    if (!this.compact) { await this.command('workbench.view.explorer'); return; }
    await this.showFiles();
  }); }
  dismiss(): Promise<void> { return this.run(async () => { if (this.hasEditors()) await this.showEditor(); }); }
  revealEditor(): Promise<void> { return this.run(() => this.showEditor()); }
  focus(): Promise<void> { return this.run(async () => {
    if (this.compact && (this.browsing || !this.hasEditors())) await this.showFiles();
    else await this.command('workbench.action.focusActiveEditorGroup');
  }); }
  private hasEditors(): boolean { return vscode.window.tabGroups.all.some(group => group.tabs.length > 0); }
  private async setMode(compact: boolean): Promise<void> {
    if (this.compact === compact) return;
    const configuration = vscode.workspace.getConfiguration();
    let saved = this.state.get<readonly SavedSetting[]>(STORAGE_KEY);
    if (compact) {
      if (!saved) {
        saved = SETTINGS.map(({ key }) => ({ key, value: configuration.inspect(key)?.globalValue }));
        await this.state.update(STORAGE_KEY, saved);
      }
      for (const { key, value } of SETTINGS) await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      await this.command('workbench.action.restoreAuxiliaryBar');
      await this.command('workbench.action.closeSidebar');
      await this.command('workbench.action.closePanel');
      await this.command('workbench.action.closeAuxiliaryBar');
    } else if (saved || this.moved) {
      await this.command('workbench.action.restoreAuxiliaryBar');
      await this.command('workbench.action.closeAuxiliaryBar');
      await this.command('vscode.moveViews', { viewIds: [FILE_VIEW], destinationId: 'workbench.view.explorer' });
      this.moved = false; this.browsing = false;
      if (saved) for (const { key, value } of saved) await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      await this.state.update(STORAGE_KEY, undefined);
      await this.command('workbench.view.explorer');
      if (this.hasEditors()) await this.command('workbench.action.focusActiveEditorGroup');
    }
    this.compact = compact;
    await this.command('setContext', 'elevenex.compact', compact);
    await this.reconcile(false);
  }
  private async reconcile(selected: boolean): Promise<void> {
    if (this.compact) {
      if (!this.hasEditors() && !this.browsing) await this.showFiles();
      else if (this.browsing && selected && this.hasEditors()) await this.showEditor();
    }
    await this.context();
  }
  private async showFiles(): Promise<void> {
    if (!this.moved) {
      await this.command('vscode.moveViews', { viewIds: [FILE_VIEW], destinationId: FILE_CONTAINER });
      this.moved = true;
    }
    await this.command('workbench.action.maximizeAuxiliaryBar');
    this.browsing = true;
    await this.context();
    await this.command('workbench.explorer.fileView.focus');
  }
  private async showEditor(): Promise<void> {
    const restore = !!this.compact && (this.browsing || this.moved);
    this.browsing = false;
    await this.context();
    if (restore) {
      await this.command('workbench.action.restoreAuxiliaryBar');
      await this.command('workbench.action.closeAuxiliaryBar');
    }
    await this.command('workbench.action.focusActiveEditorGroup');
  }
  private async context(): Promise<void> {
    await this.command('elevenex.code.files-layout', !!this.compact && this.browsing);
    await this.command('setContext', 'elevenex.compactFiles', !!this.compact && this.browsing);
    await this.command('setContext', 'elevenex.hasEditors', this.hasEditors());
    await this.present(!!this.compact && this.browsing, this.hasEditors()).catch(() => undefined);
  }
  private async command(command: string, ...args: readonly unknown[]): Promise<void> {
    if (!this.stopped) await vscode.commands.executeCommand(command, ...args);
  }
  private run(work: () => Promise<void>): Promise<void> {
    const operation = this.pending.catch(() => undefined).then(async () => {
      if (this.stopped) return;
      this.applying = true;
      try { await work(); } finally { this.applying = false; }
    });
    this.pending = operation; return operation;
  }
}
