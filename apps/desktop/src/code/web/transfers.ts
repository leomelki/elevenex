import * as vscode from 'vscode';
import type { TransferState } from './contracts';

type Call = <T>(operation: string, input?: object) => Promise<T>;
/** Explorer commands use upstream selection, quick picks and notifications. Native
 * dialogs and all transfer bytes remain in main, outside the extension worker. */
export function registerTransfers(context: vscode.ExtensionContext, root: vscode.Uri, call: Call): void {
  let running = false;
  const resource = (value: unknown): vscode.Uri | undefined => {
    if (!(value instanceof vscode.Uri) || value.scheme !== root.scheme || value.authority !== root.authority || value.query || value.fragment) return undefined;
    return value;
  };
  const run = async (direction: 'upload' | 'upload-folder' | 'download', selected: unknown, selection: unknown) => {
    if (running) { void vscode.window.showInformationMessage('A file transfer is already running in this editor.'); return; }
    running = true;
    try {
      await vscode.commands.executeCommand('setContext', 'elevenex.transferRunning', true);
      let paths: string[];
      const uri = resource(selected);
      if (direction !== 'download') {
        let folder = uri ?? root;
        if ((await vscode.workspace.fs.stat(folder)).type !== vscode.FileType.Directory) folder = folder.with({ path: folder.path.slice(0, folder.path.lastIndexOf('/')) || '/' });
        paths = [folder.path];
        const dirty = vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === root.scheme && document.uri.authority === root.authority && (folder.path === '/' || document.uri.path.startsWith(folder.path + '/')));
        if (dirty) {
          const answer = await vscode.window.showWarningMessage('Save task edits before uploading files into this folder?', { modal: true }, 'Save All and Continue');
          if (answer !== 'Save All and Continue' || !await vscode.workspace.saveAll(false)) return;
        }
      } else {
        const items = Array.isArray(selection) ? selection.map(resource).filter((item): item is vscode.Uri => !!item) : [];
        const chosen = items.length ? items : uri ? [uri] : vscode.window.activeTextEditor && resource(vscode.window.activeTextEditor.document.uri) ? [vscode.window.activeTextEditor.document.uri] : [];
        if (!chosen.length) {
          const choice = await vscode.window.showQuickPick(['Choose a file in Explorer', 'Download Entire Task Folder'], { placeHolder: 'What would you like to download?' });
          if (choice === 'Choose a file in Explorer') { await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer'); return; }
          if (choice !== 'Download Entire Task Folder') return;
          chosen.push(root);
        }
        paths = chosen.map(item => item.path);
        const dirty = vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === root.scheme && document.uri.authority === root.authority && paths.some(path => path === '/' || document.uri.path === path || document.uri.path.startsWith(path + '/')));
        if (dirty) {
          const answer = await vscode.window.showWarningMessage('Download files with unsaved changes?', { modal: true, detail: 'Downloads use the files saved on the task machine.' }, 'Save All and Download', 'Download Saved Versions');
          if (!answer || answer === 'Save All and Download' && !await vscode.workspace.saveAll(false)) return;
        }
      }
      const title = direction === 'download' ? 'Downloading from task' : 'Uploading to task';
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        const { id } = await call<{ id: string }>('transfer-start', { direction, paths });
        const cancel = () => call('transfer-cancel', { id }).catch(() => undefined);
        const subscription = token.onCancellationRequested(() => { void cancel(); });
        try {
          if (token.isCancellationRequested) await cancel();
          for (;;) {
            const state = await call<TransferState>('transfer-status', { id });
            progress.report({ message: `${state.name}${state.size ? ` · ${Math.floor(state.bytes / state.size * 100)}%` : ''} · ${state.files} file${state.files === 1 ? '' : 's'}` });
            if (state.phase === 'failed') throw new Error(state.message ?? 'Transfer failed.');
            if (state.phase !== 'running') {
              if (direction !== 'download') await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
              const message = `${state.phase === 'cancelled' ? 'Transfer cancelled' : direction === 'download' ? 'Download complete' : 'Upload complete'}: ${state.files} file${state.files === 1 ? '' : 's'}${state.skipped ? `, ${state.skipped} skipped` : ''}.`;
              void vscode.window.showInformationMessage(message); return;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        } finally { subscription.dispose(); await cancel(); }
      });
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'File transfer failed.');
    } finally { running = false; await vscode.commands.executeCommand('setContext', 'elevenex.transferRunning', false); }
  };
  for (const [command, direction] of [['upload', 'upload'], ['upload-folder', 'upload-folder'], ['download', 'download']] as const) {
    context.subscriptions.push(vscode.commands.registerCommand('elevenex.code.' + command, (selected: unknown, selection: unknown) => run(direction, selected, selection)));
  }
}
