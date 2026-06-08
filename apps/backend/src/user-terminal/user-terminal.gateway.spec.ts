import { Test, TestingModule } from '@nestjs/testing';
import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
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

    (WebSocketServer as jest.Mock).mockReturnValue(mockWss);

    mockServer = {
      on: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<HttpServer>;

    mockPtyManager = {
      kill: jest.fn(),
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
    } as unknown as jest.Mocked<WebSocket>;
    const secondWs = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
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
});
