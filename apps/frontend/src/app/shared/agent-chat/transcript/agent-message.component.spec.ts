import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeMessageComponent } from './claude-message.component';
import { incomingAgentMessage } from './agent-message';

describe('agent messages', () => {
  afterEach(() => document.documentElement.classList.remove('dark'));
  it.each(['light', 'dark'])(
    'shows WebMC routing, explains missing bodies and opens the correct agent in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      await TestBed.configureTestingModule({
        imports: [ClaudeMessageComponent],
      }).compileComponents();
      const fixture = TestBed.createComponent(ClaudeMessageComponent);
      fixture.componentRef.setInput('item', {
        id: 'incoming',
        kind: 'system',
        timestamp: '',
        content: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/item_artwork\nPayload:\n',
      });
      fixture.componentRef.setInput('agents', [
        {
          agentId: 'child-123',
          agentPath: '/root/item_artwork',
          agentType: 'item_artwork',
          status: 'started',
        },
      ]);
      fixture.componentRef.setInput('canInspectAgents', true);
      const inspected: string[] = [];
      fixture.componentInstance.inspectAgent.subscribe((id) => inspected.push(id));
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.textContent).toContain('Item Artwork');
      expect(element.textContent).toContain('to Coordinator');
      expect(element.textContent).toContain('Message content unavailable');
      expect(element.textContent).not.toContain('Payload:');
      (element.querySelector('[aria-label="Inspect Item Artwork"]') as HTMLButtonElement).click();
      expect(inspected).toEqual(['child-123']);
      (element.querySelector('[aria-expanded]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(element.textContent).toContain('without a readable body');
      expect(element.textContent).toContain('/root/item_artwork');
    },
  );
  it('preserves ordinary diagnostics and quoted envelopes in user messages', () => {
    expect(
      incomingAgentMessage({
        id: 'u',
        kind: 'user',
        timestamp: '',
        content: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/review\nPayload:\nExample',
      }),
    ).toBeNull();
    expect(
      incomingAgentMessage({
        id: 's',
        kind: 'system',
        timestamp: '',
        content: 'Warning: invalid config',
      }),
    ).toBeNull();
  });
  it('reads stored routing without deriving success or failure from the result label', () => {
    expect(
      incomingAgentMessage({
        id: 's',
        kind: 'system',
        timestamp: '',
        content:
          'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/review\nPayload:\n**Failed**: build error.',
      }),
    ).toMatchObject({ messageType: 'result', body: '**Failed**: build error.' });
  });
});
