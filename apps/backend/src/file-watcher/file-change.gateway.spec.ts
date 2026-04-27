import { Test, TestingModule } from '@nestjs/testing';
import { FileChangeGateway } from './file-change.gateway.js';
import { FileWatcherService, FileChangeEvent } from './file-watcher.service.js';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';

// Mock WebSocket and WebSocketServer
jest.mock('ws');

describe('FileChangeGateway', () => {
  let gateway: FileChangeGateway;
  let mockFileWatcher: jest.Mocked<FileWatcherService>;
  let mockWss: jest.Mocked<WebSocketServer>;
  let mockServer: jest.Mocked<HttpServer>;

  beforeEach(async () => {
    // Create mock WebSocketServer
    mockWss = {
      handleUpgrade: jest.fn(),
      emit: jest.fn(),
      on: jest.fn().mockReturnThis(),
      close: jest.fn(),
    } as unknown as jest.Mocked<WebSocketServer>;

    // Mock WebSocketServer constructor
    (WebSocketServer as jest.Mock).mockReturnValue(mockWss);

    // Create mock FileWatcherService
    mockFileWatcher = {
      watchWorktree: jest.fn(),
      unwatchWorktree: jest.fn().mockResolvedValue(undefined),
      isWatching: jest.fn().mockReturnValue(false),
      getActiveWatcherCount: jest.fn().mockReturnValue(0),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileWatcherService>;

    // Create mock HTTP server
    mockServer = {
      on: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<HttpServer>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileChangeGateway,
        {
          provide: FileWatcherService,
          useValue: mockFileWatcher,
        },
      ],
    }).compile();

    gateway = module.get<FileChangeGateway>(FileChangeGateway);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('attachToServer', () => {
    it('should create WebSocketServer at /file-changes path', () => {
      gateway.attachToServer(mockServer);

      expect(WebSocketServer).toHaveBeenCalledWith({ noServer: true });
      expect(mockServer.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
    });

    it('should handle upgrade requests for /file-changes path', () => {
      gateway.attachToServer(mockServer);

      const upgradeHandler = mockServer.on.mock.calls.find(
        (call) => call[0] === 'upgrade',
      )?.[1];

      expect(upgradeHandler).toBeDefined();

      // Simulate an upgrade request
      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };
      const mockSocket = { destroy: jest.fn() };
      const mockHead = Buffer.alloc(0);

      if (upgradeHandler) {
        upgradeHandler(mockRequest, mockSocket, mockHead);
      }

      expect(mockWss.handleUpgrade).toHaveBeenCalledWith(
        mockRequest,
        mockSocket,
        mockHead,
        expect.any(Function),
      );
    });

    it('should not handle upgrade requests for other paths', () => {
      gateway.attachToServer(mockServer);

      const upgradeHandler = mockServer.on.mock.calls.find(
        (call) => call[0] === 'upgrade',
      )?.[1];

      const mockRequest = {
        url: '/other-path',
        headers: { host: 'localhost:3000' },
      };
      const mockSocket = { destroy: jest.fn() };
      const mockHead = Buffer.alloc(0);

      if (upgradeHandler) {
        upgradeHandler(mockRequest, mockSocket, mockHead);
      }

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.destroy).not.toHaveBeenCalled();
    });
  });

  describe('connection handling', () => {
    it('should accept connection with valid worktreePath', () => {
      gateway.attachToServer(mockServer);

      // Simulate connection event
      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs, mockRequest);
      }

      expect(mockWs.close).not.toHaveBeenCalled();
      expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockFileWatcher.watchWorktree).toHaveBeenCalledWith(
        '/test/worktree',
        expect.any(Function),
      );
    });

    it('should reject connection without worktreePath (1008 error)', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs, mockRequest);
      }

      expect(mockWs.close).toHaveBeenCalledWith(1008, 'Missing worktreePath');
      expect(mockFileWatcher.watchWorktree).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('should send message to all clients watching specific worktree', () => {
      gateway.attachToServer(mockServer);

      // Simulate two clients connecting to same worktree
      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs1 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockWs2 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs1, mockRequest);
        connectionHandler(mockWs2, mockRequest);
      }

      // Trigger broadcast
      const event: FileChangeEvent = {
        event: 'change',
        path: 'src/file.ts',
        worktreePath: '/test/worktree',
      };

      gateway.broadcast('/test/worktree', event);

      const expectedMessage = JSON.stringify({
        type: 'file-change',
        event: 'change',
        path: 'src/file.ts',
        worktreePath: '/test/worktree',
      });

      expect(mockWs1.send).toHaveBeenCalledWith(expectedMessage);
      expect(mockWs2.send).toHaveBeenCalledWith(expectedMessage);
    });

    it('should not send to clients watching different worktree', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs1 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockWs2 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      // Connect client 1 to /test/worktree1
      const mockRequest1 = {
        url: '/file-changes?worktreePath=/test/worktree1',
        headers: { host: 'localhost:3000' },
      };

      // Connect client 2 to /test/worktree2
      const mockRequest2 = {
        url: '/file-changes?worktreePath=/test/worktree2',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs1, mockRequest1);
        connectionHandler(mockWs2, mockRequest2);
      }

      // Broadcast to worktree1
      const event: FileChangeEvent = {
        event: 'change',
        path: 'src/file.ts',
        worktreePath: '/test/worktree1',
      };

      gateway.broadcast('/test/worktree1', event);

      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).not.toHaveBeenCalled();
    });

    it('should only send to OPEN WebSocket connections', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWsOpen = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockWsClosed = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.CLOSED,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWsOpen, mockRequest);
        connectionHandler(mockWsClosed, mockRequest);
      }

      const event: FileChangeEvent = {
        event: 'change',
        path: 'src/file.ts',
        worktreePath: '/test/worktree',
      };

      gateway.broadcast('/test/worktree', event);

      expect(mockWsOpen.send).toHaveBeenCalled();
      expect(mockWsClosed.send).not.toHaveBeenCalled();
    });
  });

  describe('client disconnect', () => {
    it('should remove client from clients map on disconnect', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs, mockRequest);
      }

      // Get the close handler
      const closeHandler = mockWs.on.mock.calls.find(
        (call) => call[0] === 'close',
      )?.[1];

      if (closeHandler) {
        closeHandler();
      }

      // Broadcast should not send to disconnected client
      const event: FileChangeEvent = {
        event: 'change',
        path: 'src/file.ts',
        worktreePath: '/test/worktree',
      };

      gateway.broadcast('/test/worktree', event);

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should unwatch worktree when last client disconnects', async () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs, mockRequest);
      }

      const closeHandler = mockWs.on.mock.calls.find(
        (call) => call[0] === 'close',
      )?.[1];

      if (closeHandler) {
        closeHandler();
      }

      expect(mockFileWatcher.unwatchWorktree).toHaveBeenCalledWith('/test/worktree');
    });

    it('should not unwatch worktree if other clients remain', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs1 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockWs2 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs1, mockRequest);
        connectionHandler(mockWs2, mockRequest);
      }

      // Disconnect client 1
      const closeHandler1 = mockWs1.on.mock.calls.find(
        (call) => call[0] === 'close',
      )?.[1];

      if (closeHandler1) {
        closeHandler1();
      }

      expect(mockFileWatcher.unwatchWorktree).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should close all WebSocket connections', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs1 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockWs2 = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest1 = {
        url: '/file-changes?worktreePath=/test/worktree1',
        headers: { host: 'localhost:3000' },
      };

      const mockRequest2 = {
        url: '/file-changes?worktreePath=/test/worktree2',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs1, mockRequest1);
        connectionHandler(mockWs2, mockRequest2);
      }

      gateway.onModuleDestroy();

      expect(mockWs1.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(mockWs2.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(mockWss.close).toHaveBeenCalled();
    });

    it('should clear clients map', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs, mockRequest);
      }

      gateway.onModuleDestroy();

      // After destroy, broadcast should not send
      const event: FileChangeEvent = {
        event: 'change',
        path: 'src/file.ts',
        worktreePath: '/test/worktree',
      };

      gateway.broadcast('/test/worktree', event);

      // send was called once during onModuleDestroy, not during broadcast
      expect(mockWs.send).toHaveBeenCalledTimes(0);
    });
  });

  describe('error handling', () => {
    it('should remove client from map on WebSocket error', () => {
      gateway.attachToServer(mockServer);

      const connectionHandler = mockWss.on.mock.calls.find(
        (call) => call[0] === 'connection',
      )?.[1];

      const mockWs = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
        send: jest.fn(),
      } as unknown as jest.Mocked<WebSocket>;

      const mockRequest = {
        url: '/file-changes?worktreePath=/test/worktree',
        headers: { host: 'localhost:3000' },
      };

      if (connectionHandler) {
        connectionHandler(mockWs, mockRequest);
      }

      const errorHandler = mockWs.on.mock.calls.find(
        (call) => call[0] === 'error',
      )?.[1];

      if (errorHandler) {
        errorHandler(new Error('WebSocket error'));
      }

      // Broadcast should not send to client that had error
      const event: FileChangeEvent = {
        event: 'change',
        path: 'src/file.ts',
        worktreePath: '/test/worktree',
      };

      gateway.broadcast('/test/worktree', event);

      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });
});