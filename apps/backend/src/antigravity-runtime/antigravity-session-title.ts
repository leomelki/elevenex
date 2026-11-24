import { lstat, mkdtemp, opendir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAugmentedEnvAsync,
  findBinaryAsync,
} from '../config/system-paths.js';
import { acpObject, AcpStdio } from './acp-stdio.js';
import {
  acpText,
  antigravityEnvironment,
  initializeAntigravity,
  sessionOptions,
} from './antigravity-acp.js';

const TITLE_TIMEOUT = 30_000;
const OUTPUT_LIMIT = 2_000;

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.size > 64_000)
      throw new Error('Unexpected Antigravity profile configuration.');
    const text = (await readFile(path, 'utf8')).trim();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    const config = acpObject(parsed);
    if (config !== parsed)
      throw new Error('Invalid Antigravity profile configuration.');
    return config;
  } catch (error) {
    if (acpObject(error).code === 'ENOENT') return {};
    throw error;
  }
}

/** A title request must not activate global tools or hooks before ACP can refuse them. */
async function hasPersonalAutomation(geminiDir: string): Promise<boolean> {
  const config = join(geminiDir, 'config');
  const [hooks, mcp] = await Promise.all([
    readConfig(join(config, 'hooks.json')),
    readConfig(join(config, 'mcp_config.json')),
  ]);
  const configured = [hooks.hooks ?? hooks, mcp.mcpServers ?? mcp].some(
    (value) => {
      const entries = acpObject(value);
      return (
        value !== entries ||
        Object.keys(entries).some((key) => key !== '$schema')
      );
    },
  );
  if (configured) return true;

  try {
    const plugins = await opendir(join(config, 'plugins'));
    try {
      return (await plugins.read()) !== null;
    } finally {
      await plugins.close();
    }
  } catch (error) {
    if (acpObject(error).code === 'ENOENT') return false;
    throw error;
  }
}

export async function generateAntigravitySessionTitle(
  prompt: string,
  lifetime: AbortSignal | undefined,
): Promise<string | null> {
  const deadline = AbortSignal.timeout(TITLE_TIMEOUT);
  const signal = lifetime ? AbortSignal.any([lifetime, deadline]) : deadline;
  const binary = await findBinaryAsync('agy');
  signal.throwIfAborted();
  if (!binary) return null;
  const env = await buildAugmentedEnvAsync(process.env, undefined, { signal });
  const geminiDir = join(
    (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir(),
    '.gemini',
  );
  if (await hasPersonalAutomation(geminiDir)) return null;

  const cwd = await mkdtemp(join(tmpdir(), 'elevenex-agy-title-'));
  let transport: AcpStdio | undefined;
  let sessionId = '';
  let canClose = false;
  let output = '';
  const abort = () => transport?.close();
  try {
    signal.throwIfAborted();
    transport = new AcpStdio(
      binary,
      cwd,
      antigravityEnvironment(env),
      {
        request: () => abort(),
        notification: (method, params) => {
          if (method !== 'session/update' || params.sessionId !== sessionId)
            return;
          const update = acpObject(params.update);
          if (
            update.sessionUpdate === 'tool_call' ||
            update.sessionUpdate === 'tool_call_update'
          ) {
            abort();
          } else if (update.sessionUpdate === 'agent_message_chunk') {
            const content = acpObject(update.content);
            if (content.type !== 'text') return;
            output += acpText(content.text, OUTPUT_LIMIT + 1);
            if (output.length > OUTPUT_LIMIT) abort();
          }
        },
      },
      [
        '--gemini-dir',
        geminiDir,
        '--sandbox',
        '--include-default-customizations=false',
        '--log-file',
        join(cwd, 'acp.log'),
      ],
    );
    signal.addEventListener('abort', abort, { once: true });
    const capabilities = await initializeAntigravity(transport);
    canClose = acpObject(capabilities.sessionCapabilities).close != null;
    const opened = await transport.request('session/new', {
      cwd,
      mcpServers: [],
    });
    if (
      typeof opened.sessionId !== 'string' ||
      !opened.sessionId.trim() ||
      opened.sessionId.length > 1_000
    )
      return null;
    sessionId = opened.sessionId;
    const mode = sessionOptions(opened).mode;
    if (!mode?.values.some(({ id }) => id === 'default')) return null;
    if (mode.current !== 'default') {
      if (mode.configId) {
        const applied = await transport.request('session/set_config_option', {
          sessionId,
          configId: mode.configId,
          value: 'default',
        });
        if (sessionOptions(applied).mode?.current !== 'default') return null;
      } else {
        await transport.request('session/set_mode', {
          sessionId,
          modeId: 'default',
        });
      }
    }
    const result = await transport.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    signal.throwIfAborted();
    if (transport.closed || result.stopReason !== 'end_turn') return null;
    return output.trim() || null;
  } finally {
    if (canClose && sessionId && transport && !transport.closed)
      await transport
        .request('session/close', { sessionId }, 500)
        .catch(() => undefined);
    signal.removeEventListener('abort', abort);
    await transport?.closeAndWait();
    await rm(cwd, { recursive: true, force: true, maxRetries: 2 });
  }
}
