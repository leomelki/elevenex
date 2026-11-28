import { BrowserWindow, dialog, webContents } from 'electron';
import type { TransferDialogs } from './transfer-contracts';

export function codeTransferDialogs(windowId: () => number): TransferDialogs {
  const owner = () => {
    const contents = webContents.fromId(windowId()), window = contents && BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed()) throw new Error('Editor window closed.');
    return window;
  };
  return {
    async upload(folder) {
      const result = await dialog.showOpenDialog(owner(), { title: folder ? 'Upload Folder to Task' : 'Upload Files to Task', buttonLabel: 'Upload', properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'] });
      return result.canceled ? [] : result.filePaths;
    },
    async download(name) {
      const result = await dialog.showSaveDialog(owner(), { title: 'Download from Task', buttonLabel: 'Download', defaultPath: name, properties: ['showOverwriteConfirmation', 'createDirectory'] });
      return result.canceled ? undefined : result.filePath;
    },
    async downloadDirectory() {
      const result = await dialog.showOpenDialog(owner(), { title: 'Download Selected Files to Folder', buttonLabel: 'Download Here', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? undefined : result.filePaths[0];
    },
    async replace(name) {
      const result = await dialog.showMessageBox(owner(), { type: 'question', message: 'Replace existing task file?', detail: name, buttons: ['Replace', 'Skip', 'Replace All', 'Skip All', 'Cancel Transfer'], defaultId: 1, cancelId: 4, noLink: true });
      return (['replace', 'skip', 'replace-all', 'skip-all', 'cancel'] as const)[result.response] ?? 'cancel';
    },
  };
}
