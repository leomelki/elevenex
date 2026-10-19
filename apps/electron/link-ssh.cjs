// SSH relay transport.
//
// For networks where the two desktops cannot reach each other or the internet,
// but both can reach the same SSH server. Nothing is installed on that server:
// the sharing side reverse-forwards its link listener to a loopback port there
// (`ssh -R`), and the connecting side forwards a local port to that same remote
// port (`ssh -L`). sshd copies the bytes; the link handshake on top still
// authenticates both ends with the pairing key, so other users of the server
// who can reach that loopback port get nowhere without the code.
//
// The endpoint is `ssh://[user@]host:sshPort/relayPort`. Credentials stay with
// each machine's own SSH agent and config — the code carries no SSH secret.

'use strict';

const { spawn } = require('node:child_process');
const { randomInt } = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');

const RELAY_PORT_MIN = 20000;
const RELAY_PORT_MAX = 60000;
// A reverse forward is only confirmed in ssh's debug output. Should a client
// word it differently, a tunnel that has stayed up this long is taken as ready
// rather than failing a connection that is in fact working.
const READY_FALLBACK_MS = 20000;
const STDERR_LINES_KEPT = 40;

function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function randomRelayPort() {
  return randomInt(RELAY_PORT_MIN, RELAY_PORT_MAX);
}

function formatSshEndpoint({ host, port = 22, user = '', relayPort }) {
  const hostText = `${host || ''}`.trim();
  if (!hostText || /[\s/@]/.test(hostText)) {
    throw new Error('An SSH host is required.');
  }
  const sshPort = Number(port);
  const remotePort = Number(relayPort);
  if (!isValidPort(sshPort)) {
    throw new Error('The SSH port must be between 1 and 65535.');
  }
  if (!isValidPort(remotePort)) {
    throw new Error('The relay port must be between 1 and 65535.');
  }
  const userText = `${user || ''}`.trim();
  const hostPart = hostText.includes(':') && !hostText.startsWith('[') ? `[${hostText}]` : hostText;
  return `ssh://${userText ? `${encodeURIComponent(userText)}@` : ''}${hostPart}:${sshPort}/${remotePort}`;
}

function parseSshEndpoint(endpoint) {
  let url;
  try {
    url = new URL(`${endpoint}`.trim());
  } catch {
    throw new Error(`Invalid SSH relay endpoint: ${endpoint}`);
  }
  if (url.protocol !== 'ssh:' || !url.hostname) {
    throw new Error(`SSH relay endpoint must look like ssh://user@host:22/40000, got ${endpoint}`);
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port ? Number.parseInt(url.port, 10) : 22;
  const relayPort = Number.parseInt(url.pathname.replace(/^\//, ''), 10);
  if (!isValidPort(port) || !isValidPort(relayPort)) {
    throw new Error(`SSH relay endpoint has an invalid port: ${endpoint}`);
  }
  return { host, port, user: decodeURIComponent(url.username || ''), relayPort };
}

function normalizeSshEndpoint(endpoint) {
  return formatSshEndpoint(parseSshEndpoint(endpoint));
}

// `forward` is ['-R' | '-L', spec]. Never interactive: a prompt would hang in a
// background process nobody can answer, so auth must come from an agent, a key
// in the SSH config, or the identity file given here.
function buildSshTunnelArgs({ host, port, user, identityFile, forward }) {
  const args = [
    '-v',
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // A multiplexed master would carry the forward on its own connection and
    // outlive this process, leaving nothing to supervise.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-p', String(port),
  ];
  if (user) {
    args.push('-l', user);
  }
  if (identityFile) {
    args.push('-i', identityFile, '-o', 'IdentitiesOnly=yes');
  }
  args.push(...forward, host);
  return args;
}

// Debug lines are kept for spotting readiness but are noise in a user-facing
// error; what is left is ssh's own explanation ("Permission denied", ...).
function summarizeSshError(lines, { host, relayPort }) {
  const text = lines.filter((line) => !/^debug\d?:|^OpenSSH_|^Transferred:|^Authenticated /.test(line)).join('\n');
  if (/remote port forwarding failed/i.test(text)) {
    return `Port ${relayPort} is already in use on ${host}. Pick another relay port.`;
  }
  if (/Permission denied/i.test(text)) {
    return `${host} refused the SSH login. Load the key into your SSH agent or choose a private key.`;
  }
  if (/Host key verification failed/i.test(text)) {
    return `${host} is not a known SSH host. Connect to it once from a terminal to trust its host key.`;
  }
  const last = text.trim().split('\n').filter(Boolean).slice(-2).join(' ');
  return last || `The SSH connection to ${host} closed.`;
}

class SshTunnel extends EventEmitter {
  constructor({ host, port = 22, user = '', identityFile = '', mode, listenPort, targetPort, relayPort, signal, spawnProcess = spawn }) {
    super();
    this.host = host;
    this.relayPort = relayPort;
    this.mode = mode;
    this.stderr = [];
    this.closed = false;
    this.error = null;

    const spec = mode === 'remote'
      ? `127.0.0.1:${relayPort}:127.0.0.1:${targetPort}`
      : `127.0.0.1:${listenPort}:127.0.0.1:${relayPort}`;
    this.args = buildSshTunnelArgs({
      host,
      port,
      user,
      identityFile,
      forward: [mode === 'remote' ? '-R' : '-L', spec],
    });

    let markReady;
    let markFailed;
    this.ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
    // Nobody may be awaiting readiness when a tunnel dies later on.
    this.ready.catch(() => {});
    this.whenClosed = new Promise((resolve) => this.once('close', resolve));

    let isReady = false;
    const setReady = () => {
      if (isReady || this.closed) return;
      isReady = true;
      clearTimeout(fallback);
      markReady();
    };
    const fallback = setTimeout(setReady, READY_FALLBACK_MS);
    fallback.unref?.();

    this.child = spawnProcess('ssh', this.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    let pending = '';
    this.child.stderr?.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        this.stderr.push(line);
        if (this.stderr.length > STDERR_LINES_KEPT) this.stderr.shift();
        if (mode === 'remote' && /remote forward success/i.test(line)) setReady();
        if (mode === 'local' && /Local connections to|Entering interactive session/i.test(line)) setReady();
        // Forwards declared in the user's own SSH config may fail harmlessly;
        // only ours ends the tunnel.
        if (mode === 'remote' && new RegExp(`remote port forwarding failed for listen port ${relayPort}\\b`, 'i').test(line)) {
          this.close();
        }
        if (mode === 'local' && /Could not request local forwarding/i.test(line)) this.close();
      }
    });

    const finish = (error) => {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(fallback);
      signal?.removeEventListener('abort', onAbort);
      this.error = error || new Error(summarizeSshError(this.stderr, { host, relayPort }));
      markFailed(this.error);
      this.emit('close', this.error);
    };
    this.child.once('error', (error) => {
      finish(error.code === 'ENOENT' ? new Error('ssh is not installed on this machine.') : error);
    });
    this.child.once('close', () => finish(null));

    const onAbort = () => this.close();
    if (signal?.aborted) {
      this.close();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  }

  close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
    return this.whenClosed;
  }
}

function openSshTunnel(options) {
  return new SshTunnel(options);
}

// Reserves a loopback port for `ssh -L`. Released before ssh binds it, so
// another process could take it in between; ssh then fails the forward and the
// connecting side simply retries with a fresh port.
function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

module.exports = {
  buildSshTunnelArgs,
  formatSshEndpoint,
  normalizeSshEndpoint,
  openSshTunnel,
  parseSshEndpoint,
  randomRelayPort,
  reserveLoopbackPort,
  summarizeSshError,
};
