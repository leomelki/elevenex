#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../..');
const requireFromE2e = createRequire(path.join(repoRoot, 'e2e/package.json'));
const DEFAULT_FRONTEND_URL = 'http://127.0.0.1:4200';
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:11111';

const HELP = `Capture and verify an Elevenex UI screenshot.

Usage:
  pnpm screenshot:ui --session <id> --name <name> [options]
  pnpm screenshot:ui --path </route> --name <name> --state none [options]

Options:
  --session <id>       Open /sessions/<id>.
  --path </route>      Open an arbitrary app route instead of a session.
  --name <name>        Output basename (default: elevenex-ui-<timestamp>).
  --output <path>      Exact PNG path, relative to repo or absolute.
  --state <mode>       contextual-prompt (default for sessions) or none.
  --prompt <text>      Pin the prompt containing this text.
  --prompt-index <n>   Pin a zero-based prompt index; negative counts from end.
  --actions <json>     Run ordered browser actions before capture (JSON array).
  --verify-selector <css>
                       Fail unless this element is visible before capture.
  --selector <css>     Capture one element instead of the full viewport.
  --backend-url <url>  Backend origin (default: http://127.0.0.1:11111).
  --frontend-url <url> Frontend origin (default: http://127.0.0.1:4200).
  --theme <mode>       light (default) or dark.
  --width <px>         Viewport width (default: 1600).
  --height <px>        Viewport height (default: 1000).
  --wait <ms>          Extra settling time after load (default: 3500).
  --help               Show this help.
`;

function parseArgs(argv) {
  const values = {};
  const boolean = new Set(['help']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (boolean.has(key)) {
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function integer(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseActions(value) {
  if (value === undefined) return [];

  let actions;
  try {
    actions = JSON.parse(value);
  } catch (error) {
    throw new Error(`--actions must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(actions)) throw new Error('--actions must be a JSON array');
  if (actions.length > 50) throw new Error('--actions supports at most 50 steps');

  const selectorActions = new Set(['click', 'dblclick', 'hover', 'fill', 'press', 'waitFor']);
  const supportedActions = new Set([...selectorActions, 'wait', 'dragTo']);
  return actions.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`--actions step ${index + 1} must be an object`);
    }
    if (!supportedActions.has(step.action)) {
      throw new Error(`--actions step ${index + 1} has unsupported action: ${String(step.action)}`);
    }
    if (selectorActions.has(step.action) && (typeof step.selector !== 'string' || !step.selector)) {
      throw new Error(`--actions step ${index + 1} (${step.action}) requires a selector`);
    }
    if (step.index !== undefined && (!Number.isInteger(step.index) || step.index < 0)) {
      throw new Error(`--actions step ${index + 1} index must be a non-negative integer`);
    }
    if (step.action === 'fill' && typeof step.value !== 'string') {
      throw new Error(`--actions step ${index + 1} (fill) requires a string value`);
    }
    if (step.action === 'press' && (typeof step.key !== 'string' || !step.key)) {
      throw new Error(`--actions step ${index + 1} (press) requires a key`);
    }
    if (step.action === 'wait' && (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > 60_000)) {
      throw new Error(`--actions step ${index + 1} wait must be between 0 and 60000 ms`);
    }
    if (step.action === 'waitFor' && step.state !== undefined && !['attached', 'detached', 'visible', 'hidden'].includes(step.state)) {
      throw new Error(`--actions step ${index + 1} waitFor state must be attached, detached, visible, or hidden`);
    }
    if (step.action === 'dragTo' && (
      typeof step.source !== 'string' || !step.source || typeof step.target !== 'string' || !step.target
    )) {
      throw new Error(`--actions step ${index + 1} (dragTo) requires source and target selectors`);
    }
    for (const key of ['sourceIndex', 'targetIndex']) {
      if (step[key] !== undefined && (!Number.isInteger(step[key]) || step[key] < 0)) {
        throw new Error(`--actions step ${index + 1} ${key} must be a non-negative integer`);
      }
    }
    return step;
  });
}

function actionLocator(page, step) {
  const locator = page.locator(step.selector);
  return step.index === undefined ? locator : locator.nth(step.index);
}

async function runActions(page, actions) {
  for (const [index, step] of actions.entries()) {
    console.log(`Action ${index + 1}/${actions.length}: ${step.action}`);
    switch (step.action) {
      case 'click':
        await actionLocator(page, step).click();
        break;
      case 'dblclick':
        await actionLocator(page, step).dblclick();
        break;
      case 'hover':
        await actionLocator(page, step).hover();
        break;
      case 'fill':
        await actionLocator(page, step).fill(step.value);
        break;
      case 'press':
        await actionLocator(page, step).press(step.key);
        break;
      case 'waitFor':
        await actionLocator(page, step).waitFor({ state: step.state || 'visible' });
        break;
      case 'wait':
        await page.waitForTimeout(step.ms);
        break;
      case 'dragTo': {
        const source = page.locator(step.source);
        const target = page.locator(step.target);
        await (step.sourceIndex === undefined ? source : source.nth(step.sourceIndex))
          .dragTo(step.targetIndex === undefined ? target : target.nth(step.targetIndex));
        break;
      }
    }
  }
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'elevenex-ui';
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilHealthy(url, child, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(url)) return;
    if (child?.exitCode !== null) {
      throw new Error(`${label} exited before becoming ready. See ${child.logPath}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1000}s${child ? `. See ${child.logPath}` : ''}`);
}

async function startServer(command, args, logName) {
  const logPath = path.join(process.env.TMPDIR || '/tmp', logName);
  const log = await open(logPath, 'w');
  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', log.fd, log.fd],
    env: process.env,
  });
  child.logPath = logPath;
  child.logHandle = log;
  return child;
}

async function stopServer(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // It may already have exited.
  }
  await child.logHandle?.close();
}

async function printLogTail(child) {
  if (!child?.logPath) return;
  try {
    const content = await readFile(child.logPath, 'utf8');
    const tail = content.trim().split('\n').slice(-25).join('\n');
    if (tail) console.error(`\nLast ${path.basename(child.logPath)} lines:\n${tail}`);
  } catch {
    // The primary failure remains more useful than a log-read failure.
  }
}

async function availableSessionSummary(backendUrl) {
  try {
    const response = await fetch(`${backendUrl}/api/navigation/tree/light`);
    if (!response.ok) return '';
    const projects = await response.json();
    const sessions = [];
    for (const project of projects) {
      for (const repo of project.repos || []) {
        for (const workspace of repo.workspaces || []) {
          for (const session of [...(workspace.sessions || []), ...(workspace.archivedSessions || [])]) {
            sessions.push(`${session.id}: ${session.name}`);
          }
        }
      }
    }
    return sessions.length ? ` Available sessions: ${sessions.slice(-20).join('; ')}` : '';
  } catch {
    return '';
  }
}

async function chooseExecutable(chromium) {
  const candidates = [
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate;
  }
  throw new Error(
    'No Chromium browser found. Run `pnpm --dir e2e exec playwright install chromium` once, then retry.',
  );
}

async function positionContextualPrompt(page, promptText, promptIndex) {
  await page.waitForSelector('[data-user-prompt-id]', { timeout: 30_000 });

  const anchor = page.locator('.cw-contextual-prompt');
  if (await anchor.count()) {
    const text = (await anchor.innerText()).replace(/\s+/g, ' ').trim();
    if (!promptText || text.toLowerCase().includes(promptText.toLowerCase())) return text;
  }

  const prompts = page.locator('[data-user-prompt-id]');
  const count = await prompts.count();
  let indexes = Array.from({ length: count }, (_, index) => index).reverse();
  if (promptText) {
    const needle = promptText.toLowerCase();
    indexes = [];
    for (let index = 0; index < count; index += 1) {
      const text = (await prompts.nth(index).innerText()).toLowerCase();
      if (text.includes(needle)) indexes.push(index);
    }
    indexes.reverse();
    if (!indexes.length) throw new Error(`No user prompt contains: ${promptText}`);
  } else if (promptIndex !== undefined) {
    const normalized = promptIndex < 0 ? count + promptIndex : promptIndex;
    if (normalized < 0 || normalized >= count) throw new Error(`Prompt index ${promptIndex} is out of range (found ${count})`);
    indexes = [normalized];
  }

  for (const index of indexes) {
    await prompts.nth(index).evaluate(element => {
      const transcript = element.closest('.cw-transcript');
      if (!(transcript instanceof HTMLElement)) return;
      const transcriptRect = transcript.getBoundingClientRect();
      const promptRect = element.getBoundingClientRect();
      const contentBottom = transcript.scrollTop + promptRect.bottom - transcriptRect.top;
      transcript.scrollTop = Math.min(
        transcript.scrollHeight - transcript.clientHeight,
        Math.max(0, contentBottom + 20),
      );
      transcript.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(500);
    if (await anchor.count()) {
      const text = (await anchor.innerText()).replace(/\s+/g, ' ').trim();
      if (!promptText || text.toLowerCase().includes(promptText.toLowerCase())) return text;
    }
  }

  throw new Error('Could not produce a scrolled-response state with the contextual prompt visible');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  if (args.session && args.path) throw new Error('Use either --session or --path, not both');
  if (!args.session && !args.path) throw new Error('Provide --session <id> or --path </route>');
  if (args.theme && !['light', 'dark'].includes(args.theme)) throw new Error('--theme must be light or dark');
  if (args.state && !['contextual-prompt', 'none'].includes(args.state)) {
    throw new Error('--state must be contextual-prompt or none');
  }

  const width = integer(args.width, 1600, '--width');
  const height = integer(args.height, 1000, '--height');
  const settleMs = integer(args.wait, 3500, '--wait');
  const actions = parseActions(args.actions);
  const promptIndex = args['prompt-index'] === undefined ? undefined : Number(args['prompt-index']);
  if (promptIndex !== undefined && !Number.isInteger(promptIndex)) throw new Error('--prompt-index must be an integer');

  const route = args.session ? `/sessions/${encodeURIComponent(args.session)}` : args.path;
  if (!route.startsWith('/')) throw new Error('--path must start with /');
  const frontendUrl = new URL(args['frontend-url'] || DEFAULT_FRONTEND_URL).origin;
  const backendUrl = new URL(args['backend-url'] || DEFAULT_BACKEND_URL).origin;
  const state = args.state || (args.session ? 'contextual-prompt' : 'none');
  const filename = `${slug(args.name || `elevenex-ui-${timestamp()}`)}.png`;
  const outputPath = path.resolve(repoRoot, args.output || path.join('artifacts/screenshots', filename));
  const relativeOutput = path.relative(repoRoot, outputPath);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error('--output must resolve inside the Elevenex repository');
  }

  let backend;
  let frontend;
  let browser;
  try {
    if (!await isHealthy(`${backendUrl}/api/info`)) {
      if (backendUrl !== DEFAULT_BACKEND_URL) {
        throw new Error(`Backend is not reachable at ${backendUrl}; custom backends are not started automatically`);
      }
      console.log('Starting backend...');
      backend = await startServer('pnpm', ['backend:dev'], 'elevenex-screenshot-backend.log');
      await waitUntilHealthy(`${backendUrl}/api/info`, backend, 180_000, 'Backend');
    } else {
      console.log(`Reusing backend at ${backendUrl}`);
    }

    if (args.session) {
      const response = await fetch(`${backendUrl}/api/sessions/${encodeURIComponent(args.session)}`);
      if (!response.ok) {
        throw new Error(`Session ${args.session} is not available on ${backendUrl}.${await availableSessionSummary(backendUrl)}`);
      }
    }

    if (!await isHealthy(frontendUrl)) {
      if (frontendUrl !== DEFAULT_FRONTEND_URL) {
        throw new Error(`Frontend is not reachable at ${frontendUrl}; custom frontends are not started automatically`);
      }
      console.log('Starting frontend...');
      frontend = await startServer('pnpm', ['frontend:dev'], 'elevenex-screenshot-frontend.log');
      await waitUntilHealthy(frontendUrl, frontend, 180_000, 'Frontend');
    } else {
      console.log(`Reusing frontend at ${frontendUrl}`);
    }

    const { chromium } = requireFromE2e('@playwright/test');
    const executablePath = await chooseExecutable(chromium);
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.addInitScript(({ theme, backendOrigin }) => {
      window.__ELEVENEX_RUNTIME__ = {
        apiBaseUrl: `${backendOrigin}/api`,
        backendOrigin,
        mode: 'browser',
        windowId: 'w0',
      };
      localStorage.setItem('elevenex-onboarding-session@w0', JSON.stringify({
        mode: 'local',
        currentStep: 'project',
        activeServerId: null,
        remoteConnectionReady: true,
        projectHandoffAcknowledged: true,
        wsl: null,
        paired: null,
      }));
      localStorage.setItem('elevenex-theme', theme);
    }, { theme: args.theme || 'light', backendOrigin: backendUrl });

    await page.goto(`${frontendUrl}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(settleMs);
    await runActions(page, actions);

    let contextualPrompt = null;
    if (state === 'contextual-prompt') {
      await page.waitForSelector('.cw-transcript', { timeout: 30_000 });
      contextualPrompt = await positionContextualPrompt(page, args.prompt, promptIndex);
    }

    let verifiedSelector = null;
    if (args['verify-selector']) {
      const target = page.locator(args['verify-selector']).first();
      await target.waitFor({ state: 'visible', timeout: 20_000 });
      verifiedSelector = args['verify-selector'];
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    if (args.selector) {
      const target = page.locator(args.selector).first();
      await target.waitFor({ state: 'visible', timeout: 20_000 });
      await target.screenshot({ path: outputPath });
    } else {
      await page.screenshot({ path: outputPath, fullPage: false });
    }

    const result = {
      verified: state === 'contextual-prompt' ? Boolean(contextualPrompt) : true,
      route,
      frontendUrl,
      backendUrl,
      state,
      theme: args.theme || 'light',
      contextualPrompt,
      actions: actions.length,
      verifiedSelector,
      width,
      height,
      output: outputPath,
    };
    console.log(JSON.stringify(result, null, 2));
    console.log(`SCREENSHOT_PATH=${outputPath}`);
  } catch (error) {
    if (backend?.exitCode !== null) await printLogTail(backend);
    if (frontend?.exitCode !== null) await printLogTail(frontend);
    throw error;
  } finally {
    await browser?.close();
    await stopServer(frontend);
    await stopServer(backend);
  }
}

main().catch(error => {
  console.error(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
