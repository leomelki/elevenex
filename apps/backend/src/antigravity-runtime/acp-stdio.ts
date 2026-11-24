import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

type RpcId = string | number;
type RpcObject = Record<string, unknown>;

export function acpObject(value: unknown): RpcObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RpcObject)
    : {};
}

/** Bounded provider error text, for classifying failures such as exhausted quota. */
const ERROR_DETAIL_LIMIT = 4_000;

export class AcpRequestError extends Error {
  constructor(
    readonly code: number,
    method: string,
    /** Provider text is classified, never shown verbatim to the desktop. */
    readonly detail = '',
  ) {
    super(`Antigravity rejected ${method} (ACP error ${code}).`);
  }
}

function errorDetail(error: RpcObject): string {
  const message = typeof error.message === 'string' ? error.message : '';
  let data = '';
  if (error.data !== undefined) {
    try {
      data = JSON.stringify(error.data) ?? '';
    } catch {
      data = '';
    }
  }
  return `${message.slice(0, ERROR_DETAIL_LIMIT)} ${data}`
    .trim()
    .slice(0, ERROR_DETAIL_LIMIT);
}

interface AcpHandlers {
  request(method: string, params: RpcObject): unknown;
  notification(method: string, params: RpcObject): void;
  closed?(error: Error): void;
}

const FRAME_LIMIT = 32 * 1024 * 1024;

/** One ACP connection. Only the runtime owner may launch or dispose it. */
export class AcpStdio {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve(value: RpcObject): void;
      reject(error: Error): void;
      timer?: NodeJS.Timeout;
    }
  >();
  private sequence = 0;
  private buffer = '';
  private ended = false;

  constructor(
    binary: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly handlers: AcpHandlers,
    flags: readonly string[] = [],
  ) {
    this.child = spawn(binary, ['acp', ...flags], {
      cwd,
      env,
      windowsHide: true,
    });
    this.child.stdout
      .setEncoding('utf8')
      .on('data', (chunk: string) => this.receive(chunk));
    // Diagnostic stderr can contain account or workspace data.
    this.child.stderr.resume();
    this.child.stdin.on('error', () =>
      this.close(new Error('Antigravity connection closed.')),
    );
    this.child.on('error', () =>
      this.close(new Error('Could not launch the Antigravity CLI.')),
    );
    this.child.once('close', () =>
      this.close(new Error('Antigravity exited.')),
    );
  }

  get closed(): boolean {
    return this.ended;
  }

  request(
    method: string,
    params: RpcObject,
    timeoutMs = 20_000,
  ): Promise<RpcObject> {
    if (this.closed)
      return Promise.reject(new Error('Antigravity connection closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(
            () =>
              this.close(
                new Error(`Antigravity did not respond to ${method}.`),
              ),
            timeoutMs,
          ).unref()
        : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: RpcObject): void {
    this.send({ method, params });
  }

  close(error = new Error('Antigravity connection closed.')): void {
    if (this.ended) return;
    this.ended = true;
    this.buffer = '';
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.handlers.closed?.(error);
    this.child.stdin.destroy();
    if (
      this.child.exitCode !== null ||
      this.child.signalCode !== null ||
      !this.child.pid
    )
      return;
    this.child.kill();
    const force = setTimeout(() => this.child.kill('SIGKILL'), 2_000).unref();
    this.child.once('exit', () => clearTimeout(force));
  }

  async closeAndWait(): Promise<void> {
    this.close();
    if (
      !this.child.pid ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    await once(this.child, 'close', {
      signal: AbortSignal.timeout(2_500),
    }).catch(() => undefined);
  }

  private send(message: RpcObject): void {
    if (this.ended) return;
    try {
      const line = JSON.stringify({ jsonrpc: '2.0', ...message });
      if (
        Buffer.byteLength(line) > FRAME_LIMIT ||
        this.child.stdin.writableLength > FRAME_LIMIT
      ) {
        this.close(
          new Error('Antigravity request exceeded the ACP transport limit.'),
        );
        return;
      }
      this.child.stdin.write(line + '\n');
    } catch {
      this.close(new Error('Could not write to the Antigravity CLI.'));
    }
  }

  private receive(chunk: string): void {
    let offset = 0;
    while (!this.ended && offset < chunk.length) {
      const end = chunk.indexOf('\n', offset);
      const part = end < 0 ? chunk.slice(offset) : chunk.slice(offset, end);
      this.buffer += part;
      if (this.buffer.length > FRAME_LIMIT) {
        this.close(new Error('Antigravity sent an oversized ACP message.'));
        return;
      }
      if (end < 0) return;
      const line = this.buffer;
      this.buffer = '';
      offset = end + 1;
      if (!line.trim()) continue;
      try {
        this.route(acpObject(JSON.parse(line)));
      } catch {
        this.close(new Error('Antigravity sent an invalid ACP message.'));
      }
    }
  }

  private route(message: RpcObject): void {
    if (message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version.');
    const { id, method } = message;
    const params = acpObject(message.params);
    if (typeof method === 'string') {
      if (typeof id === 'string' || typeof id === 'number') {
        void this.handleRequest(id, method, params);
      } else {
        this.handlers.notification(method, params);
      }
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = acpObject(message.error);
    if (typeof error.code === 'number')
      pending.reject(
        new AcpRequestError(error.code, pending.method, errorDetail(error)),
      );
    else if ('result' in message) pending.resolve(acpObject(message.result));
    else
      pending.reject(
        new Error('Antigravity returned an invalid ACP response.'),
      );
  }

  private async handleRequest(
    id: RpcId,
    method: string,
    params: RpcObject,
  ): Promise<void> {
    try {
      const result = await this.handlers.request(method, params);
      this.send(
        result === undefined
          ? { id, error: { code: -32601, message: 'Method not supported' } }
          : { id, result },
      );
    } catch {
      this.send({
        id,
        error: { code: -32603, message: 'Client request failed' },
      });
    }
  }
}
