import * as vscode from 'vscode';

const STORAGE_KEY = 'elevenex.compact-layout';
const SETTINGS = [
  { key: 'workbench.activityBar.location', value: 'hidden' },
  { key: 'editor.wordWrap', value: 'on' },
] as const;
interface SavedSetting { readonly key: string; readonly value?: unknown }

/** Only presentation changes: upstream retains editors, selection and backups.
 * Journal the original preferences so a crash in compact mode can still restore
 * them on expansion. This profile belongs to this task's isolated workbench. */
export class CompactLayout {
  private compact?: boolean;
  constructor(private readonly state: vscode.Memento) {}

  async set(compact: boolean): Promise<void> {
    if (this.compact === compact) return;
    const configuration = vscode.workspace.getConfiguration();
    let saved = this.state.get<readonly SavedSetting[]>(STORAGE_KEY);
    if (compact) {
      if (!saved) {
        saved = SETTINGS.map(({ key }) => ({ key, value: configuration.inspect(key)?.globalValue }));
        await this.state.update(STORAGE_KEY, saved);
      }
      for (const { key, value } of SETTINGS) await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    } else if (saved) {
      for (const { key, value } of saved) await configuration.update(key, value, vscode.ConfigurationTarget.Global);
      await this.state.update(STORAGE_KEY, undefined);
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
    await vscode.commands.executeCommand('setContext', 'elevenex.compact', compact);
    this.compact = compact;
  }
}
