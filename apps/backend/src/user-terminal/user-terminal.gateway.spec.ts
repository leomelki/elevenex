import { Test, TestingModule } from '@nestjs/testing';
import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_WEBSOCKET_BUFFERED_BYTES } from '../websocket/bounded-send.js';
import { UserPtyManager } from './user-pty-manager.service.js';
import { UserTerminalGateway } from './user-terminal.gateway.js';
import { UserTerminalService } from './user-terminal.service.js';

jest.mock('ws');

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('UserTerminalGateway', () => {
  let gateway: UserTerminalGateway;
  let mockWss: jest.Mocked<WebSocketServer>;
  let mockServer: jest.Mocked<HttpServer>;
  let mockPtyManager: jest.Mocked<UserPtyManager>;
  let mockTerminalService: jest.Mocked<UserTerminalService>;

  beforeEach(async () => {
    mockWss = {
      handleUpgrade: jest.fn(),
      emit: jest.fn(),
      on: jest.fn().mockReturnThis(),
      close: jest.fn(),
    } as unknown as jest.Mocked<WebSocketServer>;

    (WebSocketServer as unknown as jest.Mock).mockReturnValue(mockWss);

    mockServer = {
      on: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<HttpServer>;

    mockPtyManager = {
      kill: jest.fn(),
      detach: jest.fn(),
      replayOutput: jest.fn(),
      resize: jest.fn(),
      write: jest.fn(),
    } as unknown as jest.Mocked<UserPtyManager>;

    mockTerminalService = {
      startTerminal: jest.fn(),
    } as unknown as jest.Mocked<UserTerminalService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserTerminalGateway,
        { provide: UserPtyManager, useValue: mockPtyManager },
        { provide: UserTerminalService, useValue: mockTerminalService },
      ],
    }).compile();

    gateway = module.get<UserTerminalGateway>(UserTerminalGateway);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('closes an exited shell without restarting it and starts a shell on reopen', async () => {
    gateway.attachToServer(mockServer);
    const start = createDeferred<{ success: boolean }>();
    mockTerminalService.startTerminal.mockReturnValueOnce(start.promise);
    mockTerminalService.startTerminal.mockResolvedValue({ success: true });
    const connectionHandler = mockWss.on.mock.calls.find(
      (call) => call[0] === 'connection',
    )?.[1] as (
      ws: WebSocket,
      request: { url: string; headers: { host: string } },
    ) => void;
    const handlers = new Map<string, (data?: Buffer) => void>();
    const ws = {
      on: jest.fn((event: string, handler: (data?: Buffer) => void) => {
        handlers.set(event, handler);
        return ws;
      }),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
    } as unknown as jest.Mocked<WebSocket>;
    const request = {
      url: '/user-terminal?terminalId=3',
      headers: { host: 'localhost:3000' },
    };
    connectionHandler(ws, request);
    handlers.get('message')?.(Buffer.from('queued before exit'));
    gateway.onProcessExit(3);
    expect(ws.close).toHaveBeenCalledWith(4000, 'Terminal process exited');
    handlers.get('close')?.();
    start.resolve({ success: true });
    await start.promise;
    await Promise.resolve();
    expect(mockPtyManager.write).not.toHaveBeenCalled();
    expect(mockPtyManager.detach).not.toHaveBeenCalled();
    expect(mockTerminalService.startTerminal).toHaveBeenCalledTimes(1);

    const reopened = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
    } as unknown as WebSocket;
    connectionHandler(reopened, request);
    await Promise.resolve();
    expect(mockTerminalService.startTerminal).toHaveBeenCalledTimes(2);
    // Old close events must not detach the newly started shell.
    handlers.get('close')?.();
    expect(mockPtyManager.detach).not.toHaveBeenCalled();
  });

  it('does not let a stale websocket close kill a newer user terminal connection', () => {
    gateway.attachToServer(mockServer);
    mockTerminalService.startTerminal.mockResolvedValue({ success: true });

    const connectionHandler = mockWss.on.mock.calls.find(
      (call) => call[0] === 'connection',
    )?.[1] as (
      ws: WebSocket,
      request: { url: string; headers: { host: string } },
    ) => void;

    const firstHandlers = new Map<string, () => void>();
    const firstWs = {
      on: jest.fn((event: string, handler: () => void) => {
        firstHandlers.set(event, handler);
        return firstWs;
      }),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
    } as unknown as jest.Mocked<WebSocket>;
    const secondWs = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
    } as unknown as jest.Mocked<WebSocket>;

    connectionHandler(firstWs, {
      url: '/user-terminal?terminalId=3',
      headers: { host: 'localhost:3000' },
    });
    connectionHandler(secondWs, {
      url: '/user-terminal?terminalId=3',
      headers: { host: 'localhost:3000' },
    });

    firstHandlers.get('close')?.();

    expect(firstWs.close).toHaveBeenCalledWith(
      1000,
      'New connection established',
    );
    expect(mockPtyManager.kill).not.toHaveBeenCalled();
    expect(mockPtyManager.detach).not.toHaveBeenCalled();
    expect(
      (
        gateway as unknown as { connections: Map<number, { ws: WebSocket }> }
      ).connections.get(3)?.ws,
    ).toBe(secondWs);
  });

  it('queues resize and input until the user terminal finishes starting', async () => {
    gateway.attachToServer(mockServer);
    const start = createDeferred<{ success: boolean; error?: string }>();
    mockTerminalService.startTerminal.mockReturnValue(start.promise);

    const connectionHandler = mockWss.on.mock.calls.find(
      (call) => call[0] === 'connection',
    )?.[1] as (
      ws: WebSocket,
      request: { url: string; headers: { host: string } },
    ) => void;

    const handlers = new Map<string, (data: Buffer) => void>();
    const ws = {
      on: jest.fn((event: string, handler: (data: Buffer) => void) => {
        handlers.set(event, handler);
        return ws;
      }),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
    } as unknown as jest.Mocked<WebSocket>;

    connectionHandler(ws, {
      url: '/user-terminal?terminalId=3',
      headers: { host: 'localhost:3000' },
    });

    handlers.get('message')?.(
      Buffer.from(JSON.stringify({ type: 'resize', cols: 90, rows: 24 })),
    );
    handlers.get('message')?.(Buffer.from('echo before-ready\r'));
    handlers.get('message')?.(
      Buffer.from(JSON.stringify({ type: 'resize', cols: 132, rows: 40 })),
    );

    expect(mockPtyManager.resize).not.toHaveBeenCalled();
    expect(mockPtyManager.write).not.toHaveBeenCalled();

    start.resolve({ success: true });
    await start.promise;
    await Promise.resolve();

    expect(mockPtyManager.resize).toHaveBeenCalledTimes(1);
    expect(mockPtyManager.resize).toHaveBeenCalledWith(3, 132, 40);
    expect(mockPtyManager.write).toHaveBeenCalledTimes(1);
    expect(mockPtyManager.write).toHaveBeenCalledWith(3, 'echo before-ready\r');
  });
  it.each(['close', 'error'])(
    'detaches the UI on %s and replays output on reconnect',
    async (event) => {
      gateway.attachToServer(mockServer);
      mockTerminalService.startTerminal.mockResolvedValue({
        success: true,
      });
      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1] as (
        ws: WebSocket,
        request: { url: string; headers: { host: string } },
      ) => void;
      const handlers = new Map<string, (error?: Error) => void>();
      const firstWs = {
        on: jest.fn((name: string, handler: (error?: Error) => void) => {
          handlers.set(name, handler);
          return firstWs;
        }),
        close: jest.fn(),
        send: jest.fn(),
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
      } as unknown as jest.Mocked<WebSocket>;
      const request = {
        url: '/user-terminal?terminalId=3',
        headers: { host: 'localhost:3000' },
      };
      connectionHandler(firstWs, request);
      await Promise.resolve();

      handlers.get(event)?.(new Error('Connection lost'));
      expect(mockPtyManager.detach).toHaveBeenCalledWith(3);
      expect(mockPtyManager.kill).not.toHaveBeenCalled();
      expect(
        (
          gateway as unknown as { connections: Map<number, unknown> }
        ).connections.has(3),
      ).toBe(false);

      const secondWs = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        send: jest.fn(),
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
      } as unknown as jest.Mocked<WebSocket>;
      connectionHandler(secondWs, request);
      expect(mockPtyManager.replayOutput).toHaveBeenCalledTimes(2);
      expect(mockPtyManager.replayOutput).toHaveBeenLastCalledWith(3);
      expect(
        mockPtyManager.replayOutput.mock.invocationCallOrder[1],
      ).toBeLessThan(
        mockTerminalService.startTerminal.mock.invocationCallOrder[1],
      );
    },
  );

  it('disconnects a lagging client and replays output on reconnect', async () => {
    mockTerminalService.startTerminal.mockResolvedValue({
      success: true,
    });
    const connect = (
      gateway as unknown as {
        handleConnection: (ws: WebSocket, id: number) => void;
      }
    ).handleConnection.bind(gateway);
    const handlers = new Map<string, () => void>();
    const slow = {
      readyState: WebSocket.OPEN,
      bufferedAmount: MAX_WEBSOCKET_BUFFERED_BYTES,
      on: jest.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
      }),
      send: jest.fn(),
      close: jest.fn(),
      terminate: jest.fn(() => handlers.get('close')?.()),
    };
    connect(slow as unknown as WebSocket, 3);
    await Promise.resolve();
    for (let i = 0; i < 100; i++) gateway.sendToTerminal(3, 'output');
    expect(slow.send).not.toHaveBeenCalled();
    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(mockPtyManager.detach).toHaveBeenCalledTimes(1);
    expect(mockPtyManager.kill).not.toHaveBeenCalled();

    const reconnected = {
      ...slow,
      bufferedAmount: 0,
      on: jest.fn(),
      send: jest.fn(),
      terminate: jest.fn(),
    };
    connect(reconnected as unknown as WebSocket, 3);
    gateway.sendToTerminal(3, 'new output');
    expect(mockPtyManager.replayOutput).toHaveBeenCalledTimes(2);
    expect(reconnected.send).toHaveBeenCalledWith(
      'new output',
      expect.any(Function),
    );
    expect(reconnected.terminate).not.toHaveBeenCalled();
  });
});
