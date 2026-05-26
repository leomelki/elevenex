import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface IpcUrlEvent {
  url: string;
  sessionId: number | null;
  upstreamPort: number;
}

const IPC_REGISTRY = path.join(os.homedir(), '.plannotator', 'vscode-ipc.json');

@Injectable()
export class IpcServerService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private server: ReturnType<typeof createServer> | null = null;
  private port: number = 0;
  private readonly logger = new Logger('IpcServer');
  private registeredWorktrees: Set<string> = new Set();
  private registryUpdateQueue: Promise<void> = Promise.resolve();

  async onModuleInit() {
    await this.startServer();
  }

  async onModuleDestroy() {
    await this.unregisterAllWorktrees();
    if (this.server) {
      this.server.close();
    }
  }

  private async startServer(): Promise<void> {
    const lastPort = await this.getLastPort();
    const tryPort = lastPort || 0;

    return new Promise((resolve, reject) => {
      this.server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          this.handleRequest(req, res);
        },
      );

      this.server.listen(tryPort, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          void this.saveLastPort(this.port);
          this.logger.log(`IPC server listening on port ${this.port}`);
          resolve();
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && tryPort !== 0) {
          this.logger.warn(`Port ${tryPort} in use, trying random port`);
          this.server!.listen(0, '127.0.0.1', () => {
            const address = this.server!.address();
            if (address && typeof address === 'object') {
              this.port = address.port;
              void this.saveLastPort(this.port);
              this.logger.log(`IPC server listening on port ${this.port}`);
              resolve();
            }
          });
        } else {
          reject(err);
        }
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const targetUrl = parsedUrl.searchParams.get('url');
    const sessionIdStr = parsedUrl.searchParams.get('sessionId');

    if (req.method === 'GET' && parsedUrl.pathname === '/open' && targetUrl) {
      const sessionId = sessionIdStr ? parseInt(sessionIdStr, 10) : null;
      const upstreamPort = this.extractPortFromUrl(targetUrl);

      this.logger.log(
        `Received URL: ${targetUrl}, sessionId: ${sessionId}, upstreamPort: ${upstreamPort}`,
      );

      const event: IpcUrlEvent = {
        url: targetUrl,
        sessionId: sessionId && !isNaN(sessionId) ? sessionId : null,
        upstreamPort,
      };

      this.emit('url-received', event);
      res.writeHead(200);
      res.end('ok');
    } else if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }

  private extractPortFromUrl(url: string): number {
    try {
      const parsed = new URL(url);
      return parseInt(parsed.port, 10) || 0;
    } catch {
      return 0;
    }
  }

  getPort(): number {
    return this.port;
  }

  private async getLastPort(): Promise<number | null> {
    try {
      const portFile = path.join(
        os.homedir(),
        '.plannotator',
        'app-ipc-port.json',
      );
      const data = JSON.parse(await fs.readFile(portFile, 'utf-8'));
      return data.port;
    } catch {}
    return null;
  }

  private async saveLastPort(port: number): Promise<void> {
    try {
      const dir = path.dirname(IPC_REGISTRY);
      await fs.mkdir(dir, { recursive: true });
      const portFile = path.join(
        os.homedir(),
        '.plannotator',
        'app-ipc-port.json',
      );
      await fs.writeFile(portFile, JSON.stringify({ port }));
    } catch {}
  }

  registerWorktree(worktreePath: string): void {
    if (!worktreePath) return;
    this.registeredWorktrees.add(worktreePath);
    void this.queueRegistryUpdate();
  }

  unregisterWorktree(worktreePath: string): void {
    this.registeredWorktrees.delete(worktreePath);
    void this.queueRegistryUpdate();
  }

  private async unregisterAllWorktrees(): Promise<void> {
    this.registeredWorktrees.clear();
    await this.queueRegistryUpdate();
  }

  private queueRegistryUpdate(): Promise<void> {
    const next = this.registryUpdateQueue
      .catch(() => undefined)
      .then(() => this.updateRegistry());
    this.registryUpdateQueue = next.catch(() => undefined);
    return next;
  }

  private async updateRegistry(): Promise<void> {
    try {
      const dir = path.dirname(IPC_REGISTRY);
      await fs.mkdir(dir, { recursive: true });

      let registry: Record<string, number> = {};
      try {
        registry = JSON.parse(await fs.readFile(IPC_REGISTRY, 'utf-8'));
      } catch {
        registry = {};
      }

      for (const worktree of this.registeredWorktrees) {
        registry[worktree] = this.port;
      }

      const registeredPaths = new Set(this.registeredWorktrees);
      for (const key of Object.keys(registry)) {
        if (!registeredPaths.has(key) && registry[key] === this.port) {
          delete registry[key];
        }
      }

      await fs.writeFile(IPC_REGISTRY, JSON.stringify(registry, null, 2));
    } catch (err) {
      this.logger.error(`Failed to update IPC registry: ${err}`);
    }
  }
}
