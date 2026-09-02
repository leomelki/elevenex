import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeWebsocketService } from './agent-runtime-websocket.service';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closeCount = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  addEventListener(): void {
    // Not needed for these tests.
  }
}

describe('AgentRuntimeWebsocketService', () => {
  let service: AgentRuntimeWebsocketService;

  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);

    TestBed.configureTestingModule({
      providers: [
        AgentRuntimeWebsocketService,
        { provide: AgentRuntimeProviderService, useValue: { currentProvider: 'claude' } },
      ],
    });
    service = TestBed.inject(AgentRuntimeWebsocketService);
  });

  it('reuses a single socket for repeated connects to the same session', () => {
    service.connect(7, 'claude');
    service.connect(7, 'claude');

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('keeps an owner socket alive when a borrower releases it', () => {
    // The review workspace thread dock borrows the parent session that the
    // Claude workspace already owns. Releasing the borrow must not tear down
    // the owner's live transcript stream.
    service.connect(7, 'claude');
    service.borrow(7, 'claude');

    service.releaseBorrow(7, 'claude');

    expect(FakeWebSocket.instances[0].closeCount).toBe(0);
    expect(service.isConnected(7, 'claude')).toBe(true);
  });

  it('closes a borrow-created socket once the last borrower releases it', () => {
    service.borrow(9, 'claude');

    service.releaseBorrow(9, 'claude');

    expect(FakeWebSocket.instances[0].closeCount).toBe(1);
    expect(service.isConnected(9, 'claude')).toBe(false);
  });

  it('waits for every borrower before closing a borrow-created socket', () => {
    service.borrow(9, 'claude');
    service.borrow(9, 'claude');

    service.releaseBorrow(9, 'claude');
    expect(FakeWebSocket.instances[0].closeCount).toBe(0);

    service.releaseBorrow(9, 'claude');
    expect(FakeWebSocket.instances[0].closeCount).toBe(1);
  });

  it('promotes a borrowed socket to owned when an owner connects to it', () => {
    service.borrow(11, 'claude');
    service.connect(11, 'claude');

    service.releaseBorrow(11, 'claude');

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closeCount).toBe(0);
  });

  it('still force-closes on the owner-side disconnect', () => {
    service.connect(7, 'claude');
    service.borrow(7, 'claude');

    service.disconnect(7, 'claude');

    expect(FakeWebSocket.instances[0].closeCount).toBe(1);
  });

  it('keys connections by provider as well as session', () => {
    service.connect(7, 'claude');
    service.connect(7, 'codex');

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
