import { Test, TestingModule } from '@nestjs/testing';
import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { TerminalGateway } from './terminal.gateway.js';
import { PtyManager } from './pty-manager.service.js';
import { TerminalService } from './terminal.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';

jest.mock('ws');

describe('TerminalGateway', () => {
  let gateway: TerminalGateway;
  let mockWss: jest.Mocked<WebSocketServer>;
  let mockServer: jest.Mocked<HttpServer>;
  let mockPtyManager: jest.Mocked<PtyManager>;
  let mockTerminalService: jest.Mocked<TerminalService>;
  let mockClaudeHooksService: jest.Mocked<ClaudeHooksService>;

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
    } as unknown as jest.Mocked<PtyManager>;

    mockTerminalService = {
      startSession: jest.fn(),
    } as unknown as jest.Mocked<TerminalService>;

    mockClaudeHooksService = {
      handleInterrupt: jest.fn(),
    } as unknown as jest.Mocked<ClaudeHooksService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TerminalGateway,
        { provide: PtyManager, useValue: mockPtyManager },
        { provide: TerminalService, useValue: mockTerminalService },
        { provide: ClaudeHooksService, useValue: mockClaudeHooksService },
      ],
    }).compile();

    gateway = module.get<TerminalGateway>(TerminalGateway);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('closes and cleans up the websocket when startup returns an error result', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    gateway.attachToServer(mockServer);
    mockTerminalService.startSession.mockResolvedValue({
      success: false,
      resumed: false,
      error: 'boom',
    });

    const connectionHandler = mockWss.on.mock.calls.find(
      (call) => call[0] === 'connection',
    )?.[1] as ((ws: WebSocket, request: { url: string; headers: { host: string } }) => void);

    const mockWs = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as jest.Mocked<WebSocket>;

    connectionHandler(mockWs, {
      url: '/terminal?sessionId=97',
      headers: { host: 'localhost:3000' },
    });

    await new Promise(resolve => setImmediate(resolve));

    expect(mockWs.send).toHaveBeenCalledWith('\x1b[31mFailed to start terminal: boom\x1b[0m\r\n');
    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Failed to start terminal');
    expect((gateway as unknown as { sessions: Map<number, unknown> }).sessions.has(97)).toBe(false);
  });

  it('closes and cleans up the websocket when startup throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    gateway.attachToServer(mockServer);
    mockTerminalService.startSession.mockRejectedValue(new Error('explode'));

    const connectionHandler = mockWss.on.mock.calls.find(
      (call) => call[0] === 'connection',
    )?.[1] as ((ws: WebSocket, request: { url: string; headers: { host: string } }) => void);

    const mockWs = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as jest.Mocked<WebSocket>;

    connectionHandler(mockWs, {
      url: '/terminal?sessionId=98',
      headers: { host: 'localhost:3000' },
    });

    await new Promise(resolve => setImmediate(resolve));

    expect(mockWs.send).toHaveBeenCalledWith('\x1b[31mFailed to start terminal.\x1b[0m\r\n');
    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Failed to start terminal');
    expect((gateway as unknown as { sessions: Map<number, unknown> }).sessions.has(98)).toBe(false);
  });

  it('marks Claude idle when ctrl-c is sent to the terminal', async () => {
    gateway.attachToServer(mockServer);
    mockTerminalService.startSession.mockResolvedValue({
      success: true,
      resumed: false,
    });
    mockClaudeHooksService.handleInterrupt.mockResolvedValue();

    const connectionHandler = mockWss.on.mock.calls.find(
      (call) => call[0] === 'connection',
    )?.[1] as ((ws: WebSocket, request: { url: string; headers: { host: string } }) => void);

    const messageHandlers = new Map<string, (data?: unknown) => void>();
    const mockWs = {
      on: jest.fn((event: string, handler: (data?: unknown) => void) => {
        messageHandlers.set(event, handler);
        return mockWs;
      }),
      close: jest.fn(),
      send: jest.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as jest.Mocked<WebSocket>;

    connectionHandler(mockWs, {
      url: '/terminal?sessionId=99',
      headers: { host: 'localhost:3000' },
    });

    messageHandlers.get('message')?.(Buffer.from('\x03'));
    await new Promise(resolve => setImmediate(resolve));

    expect(mockClaudeHooksService.handleInterrupt).toHaveBeenCalledWith(99);
    expect(mockPtyManager.write).toHaveBeenCalledWith(99, '\x03');
  });
});
