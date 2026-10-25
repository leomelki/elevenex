import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { RemoteHost, RemoteStage } from '@elevenex/shared';
import type { BackendRelease } from '../backend/release';
import { backendRelease } from '../backend/release';
import type { DownloadProgress } from '../backend/download';
import { RemoteError, failure, sshFailure } from './failure';
import { spawnSsh } from './ssh';
import { bootstrapScript } from './runtime-install';
import { archiveFor, type PrepareRemoteArchive } from './archives';
import type { Ask } from './askpass';
import { Wire, SocketChannels, type WireMessage } from './wire';
import { createServer, type Server } from 'node:net';

export interface RemoteTransport {
  readonly instance: string;
  readonly exited: Promise<void>;
  /** A reserved port value of zero addresses the private backend socket. */
  forward(port: number, localPort: number, onServiceChanged?: (available: boolean) => void): Promise<{ port: number; reachable: boolean; authorization: string | null; close(): Promise<void> }>;
  health(signal: AbortSignal): Promise<{ ready: boolean; instance: string }>;
  close(): Promise<void>;
}
export interface ConnectOptions {
  readonly host: RemoteHost;
  readonly root: string;
  readonly release: BackendRelease;
  readonly helper: string;
  readonly signal: AbortSignal;
  readonly interactive: boolean;
  readonly ask: Ask;
  readonly progress: (stage: RemoteStage, progress?: DownloadProgress) => void;
  readonly prepareArchive?: PrepareRemoteArchive;
  /** Process boundary injection for native failure-path tests; never exposed over IPC. */
  readonly spawn?: typeof spawnSsh;
}

export async function connectRemote(options: ConnectOptions): Promise<RemoteTransport> {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  const { progress } = options;
  const nonce = randomBytes(16).toString('hex');
  const ssh = await (options.spawn ?? spawnSsh)(options.host, await bootstrapScript(options.release, nonce), options.ask, options.interactive, signal, options.helper).catch((error: unknown) => {
    if (error instanceof RemoteError) throw error;
    throw sshFailure(error instanceof Error ? error.message : '', 'authentication');
  });
  let stage: RemoteStage = 'authentication';
  ssh.child.stdin.on('error', () => undefined);
  const transportEnded = ssh.exited.then(() => {
    const stderr = ssh.diagnostics();
    if (/EX11_COMPATIBILITY/.test(stderr)) throw failure(stage, 'compatibility', 'Remote prerequisites or runtime compatibility need attention. Verify Git, tar, head, sha256sum/shasum, and a supported Linux glibc or macOS host.', 'install-prerequisites');
    if (/EX11_CONFIGURATION/.test(stderr)) throw failure(stage, 'configuration', 'Remote setup could not safely continue. Check disk space, permissions, runtime cache integrity, and the daemon control-port conflict described in the remote development guide.', 'edit');
    if (/EX11_RUNTIME/.test(stderr)) throw failure('runtime', 'compatibility', 'The remote backend did not become ready. Check OS/libc compatibility and the backend prerequisites.', 'install-prerequisites');
    throw sshFailure(stderr, stage);
  });
  // The rejection also participates in every setup wait below.
  void transportEnded.catch(() => undefined);
  let wire: Wire | undefined;
  const setup = (async () => {
    let remoteRelease: BackendRelease | undefined;
    let buffer = '';
    let work: Promise<void> = Promise.resolve();
    let receive: (bytes: Buffer) => void;
    await new Promise<void>((resolve, reject) => {
      receive = (bytes: Buffer) => {
        try {
        buffer += bytes.toString('utf8');
        if (buffer.length > 64 * 1024) { reject(failure(stage, 'configuration', 'Remote startup output exceeds its limit. Remove output from noninteractive shell startup files.', 'edit')); return; }
        while (true) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const fields = line.split(':');
          if (fields[0] !== 'EX11' || fields[1] !== nonce) continue;
          if (fields[2] === 'platform') {
            stage = 'discovery'; progress(stage);
            try { remoteRelease = backendRelease(options.release, fields[3] ?? '', fields[4] ?? ''); }
            catch { reject(failure('discovery', 'compatibility', 'The SSH host reported an unsupported runtime target.', 'install-prerequisites')); return; }
          } else if (fields[2] === 'cache' && fields[3] === 'no') {
            if (!remoteRelease) { reject(new Error('Missing remote platform')); return; }
            const release = remoteRelease;
            work = (async () => {
              stage = 'download'; progress(stage);
              const downloadProgress = (value: DownloadProgress) => progress('download', value);
              const archive = options.prepareArchive ? await options.prepareArchive(release, signal, downloadProgress) : await archiveFor(options.root, release, signal, downloadProgress);
              signal.throwIfAborted(); stage = 'installation'; progress(stage);
              ssh.child.stdin.write(`${archive.bytes} ${archive.digest}\n`);
              const input = createReadStream(archive.path, { signal });
              // Do not end stdin: it becomes the persistent bridge channel.
              await new Promise<void>((done, failed) => { input.once('error', failed); input.once('end', done); input.pipe(ssh.child.stdin, { end: false }); });
            })();
            void work.catch(reject);
          } else if (fields[2] === 'runtime') {
            stage = 'runtime'; progress(stage);
            ssh.child.stdout.pause();
            ssh.child.stdout.removeListener('data', receive);
            wire = new Wire(ssh.child.stdout, ssh.child.stdin);
            // Runtime hello cannot precede this marker (the shell writes it
            // before exec); preserve any frames coalesced into this chunk.
            if (buffer) ssh.child.stdout.unshift(Buffer.from(buffer));
            resolve(); return;
          }
        }
        } catch (error) { reject(error); }
      };
      ssh.child.stdout.on('data', receive);
    });
    await work;
    if (!wire) throw new Error('Bridge did not start');
    const channel = wire;
    const greeting = new Promise<Extract<WireMessage, { type: 'hello' }>>((resolve, reject) => {
      const receive = (message: WireMessage) => {
        if (message.type !== 'hello') return;
        channel.removeListener('message', receive); channel.removeListener('closed', closed);
        if (message.version !== options.release.version || !message.ready) reject(failure('application', 'compatibility', 'The remote backend is not ready at the expected revision.', 'edit'));
        else resolve(message);
      };
      const closed = () => { void transportEnded.catch(reject); };
      channel.on('message', receive); channel.once('closed', closed);
    });
    ssh.child.stdout.resume();
    const hello = await greeting;
    if (options.host.forwardAgent && !hello.agentForwarding) throw failure('authentication', 'configuration', 'Agent forwarding was requested but SSH did not provide an agent socket. Check ForwardAgent in SSH config, server AllowAgentForwarding, and the local agent.', 'edit');
    const channels = new SocketChannels(channel);
    const servers = new Map<Server, Set<import('node:net').Socket>>();
    let closing = false;
    let sequence = 0;
    const health = (healthSignal: AbortSignal) => new Promise<{ ready: boolean; instance: string }>((resolve, reject) => {
      const id = ++sequence;
      const cleanup = () => { channel.removeListener('message', receive); channel.removeListener('closed', closed); healthSignal.removeEventListener('abort', aborted); };
      const receive = (message: WireMessage) => {
        if (message.type === 'pong' && message.id === id) { cleanup(); resolve({ ready: message.ready === true, instance: message.instance ?? '' }); }
      };
      const closed = () => { cleanup(); reject(new Error('Bridge closed')); };
      const aborted = () => { cleanup(); reject(healthSignal.reason); };
      channel.on('message', receive); channel.once('closed', closed); healthSignal.addEventListener('abort', aborted, { once: true });
      if (healthSignal.aborted) { aborted(); return; }
      try { channel.send({ type: 'ping', id }); } catch { closed(); }
    });
    const forward: RemoteTransport['forward'] = async (remotePort, localPort, onServiceChanged) => {
      if (closing) throw new Error('Remote transport is closing');
      const sockets = new Set<import('node:net').Socket>();
      const authorization = remotePort === 0 ? `Bearer ${randomBytes(32).toString('hex')}` : null;
      const server = createServer({ highWaterMark: 16 * 1024, allowHalfOpen: true }, socket => {
        sockets.add(socket); socket.once('close', () => sockets.delete(socket));
        if (authorization === null) { channels.open(socket, remotePort, onServiceChanged); return; }
        // The backend is a privileged API, unlike an explicitly forwarded dev
        // service. A website probing loopback must not acquire SSH authority.
        let header = Buffer.alloc(0);
        socket.setTimeout(5000, () => socket.destroy()); socket.on('error', () => socket.destroy());
        const authenticate = (chunk: Buffer) => {
          header = Buffer.concat([header, chunk]);
          const end = header.indexOf('\r\n\r\n');
          if (end < 0 && header.length <= 16384) return;
          socket.removeListener('data', authenticate); socket.pause();
          const lines = end < 0 ? [] : header.subarray(0, end).toString('latin1').split('\r\n');
          const auth = lines.filter(line => /^authorization:/i.test(line));
          if (end < 0 || end > 16384 || auth.length !== 1 || auth[0]?.slice(auth[0].indexOf(':') + 1).trim() !== authorization) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
          }
          socket.setTimeout(0);
          const upgrade = lines.some(line => /^upgrade:/i.test(line));
          const forwarded = lines.filter(line => !/^authorization:/i.test(line) && (upgrade || !/^connection:/i.test(line)));
          if (!upgrade) forwarded.push('Connection: close');
          const request = Buffer.concat([Buffer.from(forwarded.join('\r\n') + '\r\n\r\n', 'latin1'), header.subarray(end + 4)]);
          socket.unshift(request); channels.open(socket, remotePort);
        };
        socket.on('data', authenticate);
      });
      servers.set(server, sockets);
      try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(localPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); }
      catch (error) { servers.delete(server); throw error; }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Forward is unavailable');
      const close = async () => { servers.delete(server); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); };
      if (closing) { await close(); throw new Error('Remote transport is closing'); }
      server.on('error', () => channel.close());
      const probe = new Promise<boolean>(resolve => {
        const id = ++sequence;
        const finish = (available: boolean) => { clearTimeout(timer); channel.removeListener('message', receive); channel.removeListener('closed', closed); resolve(available); };
        const receive = (frame: WireMessage) => { if (frame.type === 'probed' && frame.id === id) finish(frame.available); };
        const closed = () => finish(false);
        const timer = setTimeout(() => finish(false), 4000);
        channel.on('message', receive); channel.once('closed', closed);
        try { channel.send({ type: 'probe', id, port: remotePort }); } catch { finish(false); }
      });
      const reachable = await probe;
      if (closing) { await close(); throw new Error('Remote transport is closing'); }
      return { port: address.port, authorization, reachable, close };
    };
    return { instance: hello.instance, exited: ssh.exited, health, forward,
      close: async () => {
        closing = true; cancellation.abort(); channels.dispose(); channel.close();
        for (const sockets of servers.values()) for (const socket of sockets) socket.destroy();
        await ssh.stop();
        await Promise.all([...servers.keys()].map(server => new Promise<void>(resolve => server.close(() => resolve())))); servers.clear();
      },
    };
  })();
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try { return await Promise.race([setup, transportEnded, aborted]); }
  catch (error) { cancellation.abort(); wire?.close(); await ssh.stop(); throw error; }
}
