import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatExchange } from '../conversation.models';
import { ChatComponent } from './chat.component';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

describe('sent session mentions', () => {
  it('shows read-only chips with the message, including context-only history, and retains inert labels', () => {
    const fixture = TestBed.createComponent(ChatComponent);
    const exchange: ChatExchange = { id: 'prompt', prompt: 'Compare these sessions', status: 'done', steps: [], answer: '',
      mentions: [{ id: '12', kind: 'session', label: '<b>Other work</b>' }, { id: '13', kind: 'session', label: 'Other work' }] };
    fixture.componentRef.setInput('exchanges', [exchange]); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('ex-message')?.textContent).toContain('Compare these sessions');
    expect(root.querySelectorAll('[aria-label="Mentioned sessions"] ex-mention')).toHaveLength(2);
    expect(root.querySelector('ex-mention')?.textContent).toContain('<b>Other work</b>');
    expect(root.querySelector('ex-mention b')).toBeNull();
    expect(root.querySelector('ex-mention button')).toBeNull();
    fixture.componentRef.setInput('exchanges', [{ ...exchange, prompt: '' }]); fixture.detectChanges();
    expect(root.querySelector('ex-message')).not.toBeNull();
    fixture.componentRef.setInput('exchanges', [{ ...exchange, mentions: undefined }]); fixture.detectChanges();
    expect(root.querySelector('[aria-label="Mentioned sessions"]')).toBeNull();
  });
});
