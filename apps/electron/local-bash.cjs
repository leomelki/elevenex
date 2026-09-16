'use strict';

const os = require('node:os');
const path = require('node:path');
const { access, stat } = require('node:fs/promises');
const { spawn } = require('node:child_process');

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_LENGTH = 65_536;
const MAX_TIMEOUT_MS = 120_000;

function localBashExecutable(platform = process.platform) {
  return platform === 'win32' ? 'bash.exe' : '/bin/bash';
}

async function isLocalBashSupported(platform = process.platform) {
  if (platform === 'win32') return true;
  try {
    await access(localBashExecutable(platform));
    return true;
  } catch {
    return false;
  }
}

async function validateCwd(value) {
  const cwd = `${value || ''}`.trim() || os.homedir();
  if (!path.isAbsolute(cwd)) {
    throw new Error('The local Bash working directory must be an absolute path.');
  }
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Local working directory does not exist: ${cwd}`);
  }
  return cwd;
}

function appendOutput(current, chunk) {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return { value: current, truncated: true };
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.length <= remaining) {
    return { value: current + buffer.toString('utf8'), truncated: false };
  }
  return {
    value: current + buffer.subarray(0, remaining).toString('utf8'),
    truncated: true,
  };
}

async function runLocalBash(
  { command, cwd, timeoutMs = 30_000 },
  { enabled, env = process.env, platform = process.platform, signal } = {},
) {
  if (!enabled) {
    throw new Error('Local computer Bash access is disabled in Elevenex Settings.');
  }
  const normalizedCommand = `${command || ''}`;
  if (!normalizedCommand.trim()) throw new Error('A Bash command is required.');
  if (normalizedCommand.length > MAX_COMMAND_LENGTH) throw new Error('The Bash command is too long.');
  const resolvedCwd = await validateCwd(cwd);
  const effectiveTimeout = Math.min(Math.max(1_000, Number(timeoutMs) || 30_000), MAX_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(localBashExecutable(platform), ['-lc', normalizedCommand], {
        cwd: resolvedCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const terminate = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, effectiveTimeout);
    timer.unref?.();
    const onAbort = () => terminate();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      const next = appendOutput(stdout, chunk);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const next = appendOutput(stderr, chunk);
      stderr = next.value;
      truncated ||= next.truncated;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        error && error.code === 'ENOENT'
          ? new Error('Bash is not installed on this local computer or is not on PATH.')
          : error,
      );
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode, signal, timedOut, truncated, cwd: resolvedCwd });
    });
  });
}

module.exports = {
  MAX_COMMAND_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  isLocalBashSupported,
  localBashExecutable,
  runLocalBash,
};
