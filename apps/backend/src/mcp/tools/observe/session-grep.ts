import { Worker } from 'node:worker_threads';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import {
  renderMarkdownChunks,
  type ConversationExportModel,
  type ConversationExportOptions,
} from '../../../agent-runtime/conversation-export.service.js';
import { ToolError } from '../../tool-registry/tool.types.js';
import {
  stepsRenderProjection,
  turnRenderProjection,
} from './session-grep-projection.js';

export const GREP_LIMITS = {
  timeoutMs: 5000,
  concurrentSearches: 2,
  blockInputCharacters: 2 * 1024 * 1024,
  blockInputNodes: 50_000,
  renderedCharacters: 32 * 1024 * 1024,
  lineCharacters: 2000,
  outputCharacters: 24_000,
} as const;

export interface SessionGrepOptions {
  query: string;
  isRegExp: boolean;
  caseSensitive: boolean;
  contextLines: number;
  maxMatches: number;
}

export interface SessionGrepResult {
  totalLines: number;
  matchCount: number;
  matches: { lineNumber: number; line: string; context: string }[];
  truncated: boolean;
  truncation: { matchLimit: boolean; lineLimit: boolean; outputLimit: boolean };
  returnedCharacters: number;
  limits: typeof GREP_LIMITS;
}

let activeSearches = 0;

/** JS regex runs only in a disposable worker, with backpressure on rendered chunks. */
export async function searchSessionTranscript(
  model: ConversationExportModel,
  renderOptions: ConversationExportOptions,
  options: SessionGrepOptions,
  signal: AbortSignal,
): Promise<SessionGrepResult> {
  signal.throwIfAborted();
  if (activeSearches >= GREP_LIMITS.concurrentSearches) {
    throw new ToolError({
      code: 'grep_busy',
      message:
        'Transcript search capacity is busy. Retry after a current search finishes.',
    });
  }
  activeSearches++;
  let worker: Worker | undefined;
  let releaseChunk: (() => void) | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new ToolError({
          code: 'grep_timeout',
          message: `Transcript search exceeded ${GREP_LIMITS.timeoutMs}ms and was terminated.`,
          remediation: 'Simplify the regex or use a literal search.',
        }),
      ),
    GREP_LIMITS.timeoutMs,
  );
  try {
    // Bound each synchronous render, yielding while inspecting potentially huge
    // models. No JSON.stringify/clone of the full transcript on the event loop.
    const { title, sessionId, provider, branch, exportedAt } = model.meta;
    await validateProjection(
      [title, sessionId, provider, branch, exportedAt],
      controller.signal,
    );
    if (renderOptions.precision !== 'small') {
      await validateProjection(
        stepsRenderProjection(model.preamble, renderOptions),
        controller.signal,
      );
    }
    for (const [index, turn] of model.turns.entries()) {
      if (index % 32 === 0) await yieldEventLoop();
      await validateProjection(
        turnRenderProjection(turn, renderOptions),
        controller.signal,
      );
    }
    controller.signal.throwIfAborted();
    // An inline, self-contained entry point works in dev, Jest and the Electron
    // single-file bundle; no .ts loader or separately staged worker asset.
    worker = new Worker(`(${sessionGrepWorker.toString()})()`, {
      eval: true,
      workerData: { options, limits: GREP_LIMITS },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const runningWorker = worker;
    return await new Promise<SessionGrepResult>((resolve, reject) => {
      const onAbort = () => {
        releaseChunk?.();
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      runningWorker.on('error', reject);
      runningWorker.on('exit', (code) =>
        reject(new Error(`Transcript search worker exited (${code})`)),
      );
      runningWorker.on(
        'message',
        (message: { error?: string; result?: SessionGrepResult }) => {
          if (message.error) {
            reject(
              new ToolError({
                code: 'invalid_regexp',
                message: 'Invalid JavaScript regular expression.',
                remediation: 'Fix the pattern syntax or use isRegExp:false.',
              }),
            );
          } else if (message.result) {
            resolve(message.result);
          } else {
            releaseChunk?.();
          }
        },
      );
      const send = (message: unknown) =>
        new Promise<void>((ack) => {
          releaseChunk = ack;
          runningWorker.postMessage(message);
        });
      void (async () => {
        let characters = 0;
        for (const chunk of renderMarkdownChunks(model, renderOptions)) {
          controller.signal.throwIfAborted();
          characters += chunk.length;
          if (characters > GREP_LIMITS.renderedCharacters)
            throw inputTooLarge();
          await send({ chunk });
          await yieldEventLoop();
        }
        controller.signal.throwIfAborted();
        runningWorker.postMessage({ end: true });
      })().catch(reject);
      // Close the registration race even if a caller aborts during construction.
      if (controller.signal.aborted) onAbort();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
    releaseChunk?.();
    // Rejecting is not enough: terminate interrupts a RegExp stuck in V8 code.
    if (worker) await worker.terminate();
    activeSearches--;
  }
}

function inputTooLarge(): ToolError {
  return new ToolError({
    code: 'grep_input_limit',
    message: 'Transcript exceeds the bounded search input budget.',
    remediation: 'Try a lower precision or use bounded read_session pages.',
  });
}

async function validateProjection(
  projection: Iterable<unknown>,
  signal: AbortSignal,
): Promise<void> {
  const stack: unknown[] = [];
  const values = projection[Symbol.iterator]();
  let characters = 0;
  let nodes = 0;
  while (true) {
    if (stack.length === 0) {
      const next = values.next();
      if (next.done) break;
      stack.push(next.value);
    }
    if (++nodes % 512 === 0) {
      await yieldEventLoop();
      signal.throwIfAborted();
    }
    const value = stack.pop();
    if (typeof value === 'string') characters += value.length;
    else if (value && typeof value === 'object') {
      // Avoid spreading an unbounded array into the stack or argument list.
      for (const key in value) {
        characters += key.length;
        if (
          characters > GREP_LIMITS.blockInputCharacters ||
          stack.length + nodes > GREP_LIMITS.blockInputNodes
        )
          throw inputTooLarge();
        stack.push((value as Record<string, unknown>)[key]);
      }
    }
    if (
      characters > GREP_LIMITS.blockInputCharacters ||
      nodes > GREP_LIMITS.blockInputNodes
    )
      throw inputTooLarge();
  }
  signal.throwIfAborted();
}

// Keep all runtime dependencies inside this function: its compiled JS is the
// worker entry point. Full JS RegExp semantics, reset per line just like before.
function sessionGrepWorker(): void {
  const { parentPort, workerData } =
    require('node:worker_threads') as typeof import('node:worker_threads');
  const { options, limits } = workerData as {
    options: SessionGrepOptions;
    limits: typeof GREP_LIMITS;
  };
  let pattern: RegExp;
  try {
    const query = options.isRegExp
      ? options.query
      : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(query, options.caseSensitive ? 'g' : 'gi');
  } catch {
    parentPort!.postMessage({ error: 'invalid_regexp' });
    return;
  }
  type Line = { text: string; clipped: boolean };
  type Match = {
    lineNumber: number;
    line: Line;
    context: Line[];
    remaining: number;
  };
  const before: Line[] = [];
  const matches: Match[] = [];
  let partial = '';
  let totalLines = 0;
  let matchLimit = false;
  const acceptLine = (text: string) => {
    totalLines++;
    const line = {
      text: text.slice(0, limits.lineCharacters),
      clipped: text.length > limits.lineCharacters,
    };
    for (const match of matches) {
      if (match.remaining > 0) {
        match.context.push({ ...line, text: `    ${line.text}` });
        match.remaining--;
      }
    }
    if (!matchLimit) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        if (matches.length === options.maxMatches) matchLimit = true;
        else
          matches.push({
            lineNumber: totalLines,
            line,
            context: [
              ...before.map((entry) => ({
                ...entry,
                text: `    ${entry.text}`,
              })),
              { ...line, text: `>>> ${line.text}` },
            ],
            remaining: options.contextLines,
          });
      }
    }
    before.push(line);
    if (before.length > options.contextLines) before.shift();
  };
  parentPort!.on('message', (message: { chunk?: string; end?: boolean }) => {
    if (!message.end) {
      const text = partial + message.chunk!;
      let start = 0;
      let end: number;
      while ((end = text.indexOf('\n', start)) !== -1) {
        acceptLine(text.slice(start, end));
        start = end + 1;
      }
      partial = text.slice(start);
      parentPort!.postMessage({ ack: true });
      return;
    }
    acceptLine(partial); // split('\n') includes the empty final line.
    let remaining = limits.outputCharacters as number;
    let lineLimit = false;
    let outputLimit = false;
    const take = (text: string) => {
      const result = text.slice(0, remaining);
      if (result.length < text.length) outputLimit = true;
      remaining -= result.length;
      return result;
    };
    const returned: SessionGrepResult['matches'] = [];
    for (const match of matches) {
      if (remaining === 0) {
        outputLimit = true;
        break;
      }
      lineLimit ||=
        match.line.clipped || match.context.some((line) => line.clipped);
      returned.push({
        lineNumber: match.lineNumber,
        line: take(match.line.text),
        context: take(match.context.map((line) => line.text).join('\n')),
      });
    }
    const result: SessionGrepResult = {
      totalLines,
      matchCount: returned.length,
      matches: returned,
      truncated: matchLimit || lineLimit || outputLimit,
      truncation: { matchLimit, lineLimit, outputLimit },
      returnedCharacters: limits.outputCharacters - remaining,
      limits,
    };
    parentPort!.postMessage({ result });
  });
}
