import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PresetCreatorComponent } from './preset-creator.component';
import type { PresetAgentCatalog } from './preset-catalog.models';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
const claude: PresetAgentCatalog = {
  harness: { id: 'claude', label: 'Claude Code', mark: 'Cl', models: [{ id: 'sonnet', label: 'Sonnet', thinking: ['low', 'high'], supportsFastMode: false }] },
  initial: { harness: 'claude', mark: 'Cl', model: 'sonnet', thinking: 'high', fast: false }, reasoningAvailable: true, fastAvailable: false,
};
function setup() {
  const fixture = TestBed.createComponent(PresetCreatorComponent);
  fixture.componentRef.setInput('initial', { harness: 'codex', mark: 'Cx', model: 'gpt', thinking: 'high', fast: true });
  fixture.componentRef.setInput('harnessLocked', false);
  fixture.componentRef.setInput('harnesses', [
    { id: 'codex', label: 'Codex', mark: 'Cx', models: [{ id: 'gpt', label: 'GPT', thinking: ['low', 'high'], supportsFastMode: true }] },
    { id: 'claude', label: 'Claude Code', mark: 'Cl', models: [] },
  ]);
  const requests: { signal: AbortSignal; resolve: (catalog: PresetAgentCatalog) => void; reject: (error: Error) => void }[] = [];
  const provider = vi.fn((_id: string, signal: AbortSignal) => new Promise<PresetAgentCatalog>((resolve, reject) => requests.push({ signal, resolve, reject })));
  fixture.componentRef.setInput('catalogProvider', provider);
  fixture.componentInstance.name.set('Review'); fixture.detectChanges();
  const settle = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); fixture.detectChanges(); } await fixture.whenStable(); };
  return { fixture, form: fixture.componentInstance, requests, provider, settle };
}
it('keeps a draft per harness, restores edits, and never submits on harness selection', async () => {
  const { fixture, form, requests, provider, settle } = setup(); await settle();
  const submitted = vi.fn(); form.submitted.subscribe(submitted);
  document.querySelector<HTMLButtonElement>('button[aria-label="Harness: Codex"]')!.click(); await settle();
  const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(b => b.textContent?.includes('Claude Code'))!;
  choice.click(); await settle();
  expect(form.catalogBusy()).toBe(true); expect(form.name()).toBe('Review');
  expect(document.querySelector<HTMLButtonElement>('.preset-creator button[type="submit"]')!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Harness: Claude Code"]')!.disabled).toBe(false);
  requests[0]!.resolve(claude); await settle();
  expect(form.draft()).toMatchObject({ harness: 'claude', model: 'sonnet', fast: false });
  form.change({ ...form.draft(), thinking: 'low' });
  form.change({ harness: 'codex', mark: 'Cx', model: '' }); await settle();
  expect(form.draft()).toMatchObject({ harness: 'codex', model: 'gpt', thinking: 'high', fast: true });
  form.change({ harness: 'claude', mark: 'Cl', model: '' }); await settle();
  expect(form.draft().thinking).toBe('low'); expect(provider).toHaveBeenCalledTimes(1);
  expect(submitted).not.toHaveBeenCalled();
  fixture.destroy();
});
it('ignores cancelled replies and aborts a read when the creator closes', async () => {
  const { fixture, form, requests, settle } = setup(); await settle();
  form.change({ harness: 'claude', mark: 'Cl', model: '' });
  form.change({ harness: 'codex', mark: 'Cx', model: '' });
  expect(requests[0]!.signal.aborted).toBe(true);
  requests[0]!.resolve(claude); await settle(); expect(form.draft().harness).toBe('codex');
  form.change({ harness: 'claude', mark: 'Cl', model: '' });
  fixture.componentRef.setInput('open', false); await settle();
  expect(requests[1]!.signal.aborted).toBe(true);
});
it('retains the name after a failed catalog read and permits explicit retry', async () => {
  const { form, requests, settle } = setup(); await settle();
  form.change({ harness: 'claude', mark: 'Cl', model: '' });
  requests[0]!.reject(new Error('Models unavailable')); await settle();
  expect(form.catalogError()).toBe('Models unavailable'); expect(form.name()).toBe('Review');
  expect(document.querySelector<HTMLButtonElement>('.preset-creator button[type="submit"]')!.disabled).toBe(true);
  void form.loadCatalog(); requests[1]!.resolve(claude); await settle();
  expect(form.catalogError()).toBe(''); expect(form.draft().model).toBe('sonnet');
});
