import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { SidebarPreferencesService } from './sidebar-preferences.service';

const key = 'elevenex.sidebar.session-cap';
afterEach(() => { TestBed.resetTestingModule(); localStorage.removeItem(key); vi.restoreAllMocks(); });
it('defaults to five, persists the choice and follows other windows', () => {
  const preferences = TestBed.inject(SidebarPreferencesService);
  expect(preferences.sessionCap()).toBe(5);
  preferences.setSessionCap('10'); expect(localStorage.getItem(key)).toBe('10');
  TestBed.resetTestingModule();
  const reloaded = TestBed.inject(SidebarPreferencesService);
  expect(reloaded.sessionCap()).toBe(10);
  localStorage.setItem(key,'0'); window.dispatchEvent(new StorageEvent('storage',{key}));
  expect(reloaded.sessionCap()).toBe(0);
});
it('rejects malformed storage and retains the last choice if saving fails', () => {
  localStorage.setItem(key,'-5');
  const preferences = TestBed.inject(SidebarPreferencesService);
  expect(preferences.sessionCap()).toBe(5);
  preferences.setSessionCap('999'); expect(preferences.sessionCap()).toBe(5);
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage full');});
  preferences.setSessionCap('20'); expect(preferences.sessionCap()).toBe(5); expect(preferences.error()).toContain('could not be saved');
});
