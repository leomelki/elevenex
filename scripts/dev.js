// Starts the backend, frontend, and Electron shell together for local
// development, wiring Electron to the live dev servers instead of a staged
// build. Equivalent to `dev:tmux` but works cross-platform (no tmux/zsh
// dependency), which matters on Windows where tmux isn't available.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const root = path.join(__dirname, '..');

const FRONTEND_HOST = '127.0.0.1';
const FRONTEND_PORT = 4200;
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 11111;
const READY_TIMEOUT_MS = 180000;

const children = [];
let shuttingDown = false;

function prefixOutput(child, label) {
  const prefix = `[${label}] `;
  const forward = (readable, writable) => {
    readable.setEncoding('utf8');
    let buffer = '';
    readable.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) writable.write(prefix + line + '\n');
    });
    readable.on('end', () => {
      if (buffer.length > 0) writable.write(prefix + buffer + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}

function spawnPnpm(label, args, extraEnv = {}) {
  const child = spawn('pnpm', args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  prefixOutput(child, label);
  const entry = { label, child };
  children.push(entry);
  child.on('error', (error) => {
    console.error(`[dev] failed to start ${label}: ${error.message}`);
    shutdown(1);
  });
  return entry;
}

function killEntry({ label, child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  console.log(`[dev] stopping ${label}...`);
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of children) killEntry(entry);
  process.exitCode = exitCode ?? process.exitCode ?? 0;
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (shuttingDown) {
        reject(new Error('shutting down'));
        return;
      }

      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  console.log('[dev] starting backend and frontend dev servers...');
  const backend = spawnPnpm('backend', ['backend:dev']);
  const frontend = spawnPnpm('frontend', ['frontend:dev']);

  for (const entry of [backend, frontend]) {
    entry.child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      console.error(`[dev] ${entry.label} exited unexpectedly (code ${code}, signal ${signal}), stopping.`);
      shutdown(code ?? 1);
    });
  }

  console.log('[dev] waiting for backend and frontend to be ready...');
  await waitForPort(BACKEND_HOST, BACKEND_PORT, READY_TIMEOUT_MS);
  await waitForPort(FRONTEND_HOST, FRONTEND_PORT, READY_TIMEOUT_MS);

  console.log('[dev] starting electron...');
  const electron = spawnPnpm('electron', ['--dir', 'apps/electron', 'start'], {
    ELECTRON_FRONTEND_URL: `http://${FRONTEND_HOST}:${FRONTEND_PORT}`,
    ELECTRON_BACKEND_URL: `http://${BACKEND_HOST}:${BACKEND_PORT}`,
  });
  electron.child.on('exit', (code, signal) => {
    console.log(`[dev] electron exited (code ${code}, signal ${signal}), stopping backend and frontend.`);
    shutdown(code ?? 0);
  });
}

main().catch((error) => {
  console.error('[dev]', error.message || error);
  shutdown(1);
});
