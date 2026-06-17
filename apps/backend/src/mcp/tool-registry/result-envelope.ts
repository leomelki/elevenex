import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolError, type ToolResultEnvelope } from './tool.types.js';

/**
 * Flatten a tool envelope into a CallToolResult. The model reads `content[0]`
 * as terse JSON (no pretty-printing — every space is a token); the same payload
 * is mirrored into `structuredContent` for clients that consume it natively.
 *
 * We drop `undefined` pointer fields so unused keys never cost tokens.
 */
export function envelopeToResult(env: ToolResultEnvelope): CallToolResult {
  const payload: Record<string, unknown> = { data: env.data };
  if (env.touched !== undefined) payload.touched = env.touched;
  if (env.deepLink !== undefined) payload.deepLink = env.deepLink;
  if (env.nextStep !== undefined) payload.nextStep = env.nextStep;
  if (env.truncated) payload.truncated = true;

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * Map any thrown error to a structured, self-correcting `isError` result.
 * `ToolError`s carry remediation the model can act on; unexpected errors are
 * wrapped as a generic, retryable internal error (message only, no stack).
 */
export function errorToResult(err: unknown): CallToolResult {
  const toolError =
    err instanceof ToolError
      ? err
      : new ToolError({
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
  const error: Record<string, unknown> = {
    code: toolError.code,
    message: toolError.message,
    retryable: toolError.retryable,
  };
  if (toolError.remediation) error.remediation = toolError.remediation;

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
  };
}
