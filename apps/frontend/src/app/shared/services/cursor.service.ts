import { Injectable } from '@angular/core';
import { CursorOpenResult, getElectronCursorApi } from '../runtime/electron-cursor';

export interface CursorSettings {
  mode: 'local' | 'remote';
  sshUser?: string;
  sshHost?: string;
}

const STORAGE_KEY = 'elevenex-cursor-settings';

@Injectable({ providedIn: 'root' })
export class CursorService {
  getSettings(): CursorSettings | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as CursorSettings;
    } catch {
      return null;
    }
  }

  saveSettings(settings: CursorSettings): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  isConfigured(): boolean {
    return this.getSettings() !== null;
  }

  async open(worktreePath: string): Promise<CursorOpenResult> {
    const settings = this.getSettings();
    if (!settings) {
      return { ok: false, error: 'Cursor settings not configured' };
    }

    const api = getElectronCursorApi();
    if (!api) {
      return { ok: false, error: 'Cursor integration is only available in the desktop app' };
    }

    return api.open({
      worktreePath,
      mode: settings.mode,
      sshUser: settings.sshUser,
      sshHost: settings.sshHost,
    });
  }
}
