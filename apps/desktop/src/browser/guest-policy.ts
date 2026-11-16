import type { WebPreferences } from 'electron';

/** One main-issued partition can be attached once; pages cannot choose privileges. */
export function hardenTaskGuest(
  preferences: WebPreferences,
  params: Readonly<Record<string, string>>,
  partition: string | undefined,
  bootstrap = 'about:blank',
): boolean {
  if (
    !partition ||
    params['partition'] !== partition ||
    params['src'] !== bootstrap ||
    params['preload'] ||
    params['webpreferences']
  )
    return false;
  delete preferences.preload;
  preferences.sandbox = true;
  preferences.contextIsolation = true;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.nodeIntegrationInWorker = false;
  preferences.webSecurity = true;
  preferences.allowRunningInsecureContent = false;
  preferences.webviewTag = false;
  preferences.devTools = false;
  preferences.navigateOnDragDrop = false;
  preferences.autoplayPolicy = 'document-user-activation-required';
  preferences.disableDialogs = true;
  preferences.backgroundThrottling = true;
  return true;
}
