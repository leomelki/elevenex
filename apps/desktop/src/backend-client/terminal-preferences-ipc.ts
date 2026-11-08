import type { BackendResult, TaskTerminalPreferences } from '@elevenex/shared';
import { handleForWindow, type TrustedSender } from '../ipc';
import type { BackendClient } from './client';
import { generation } from './terminal-validation';
import { terminalPreferences } from './terminal-launch-validation';
import { TerminalPreferences } from './terminal-preferences';

export function registerTerminalPreferencesIpc(client: BackendClient, trusted: TrustedSender, preferences: TerminalPreferences): () => void {
  const unavailable = (): BackendResult<never> => ({ ok: false, error: { code: 'unavailable', message: 'Terminal settings could not be loaded or saved. Your saved settings have been preserved.' } });
  const stopRead = handleForWindow('task-terminal:preferences', trusted, async (window, scope): Promise<BackendResult<TaskTerminalPreferences>> => {
    generation(scope); const machine = client.configurationIdentity(window, scope);
    if (!machine) return unavailable();
    try {
      const value = await preferences.get(machine);
      if (client.configurationIdentity(window, scope) !== machine) return unavailable();
      return { ok: true, value };
    } catch { return unavailable(); }
  });
  const stopSave = handleForWindow('task-terminal:save-preferences', trusted, async (window, scope, raw): Promise<BackendResult<{ readonly accepted: true }>> => {
    generation(scope); const value = terminalPreferences(raw), machine = client.configurationIdentity(window, scope);
    if (!machine) return unavailable();
    try {
      await preferences.save(machine, value);
      if (client.configurationIdentity(window, scope) !== machine) return unavailable();
      return { ok: true, value: { accepted: true } };
    } catch { return unavailable(); }
  });
  return () => { stopRead(); stopSave(); };
}
