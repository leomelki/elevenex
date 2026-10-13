import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolError, type ToolResultEnvelope } from './tool.types.js';
import { HttpException } from '@nestjs/common';

function domainError(error: HttpException): ToolError {
  const response = error.getResponse();
  const detail =
    typeof response === 'string'
      ? { message: response }
      : (response as Record<string, unknown>);
  const status = error.getStatus();
  const details = Object.fromEntries(
    Object.entries(detail).filter(
      ([key]) => !['code', 'message', 'statusCode', 'error'].includes(key),
    ),
  );
  return new ToolError({
    code:
      typeof detail.code === 'string'
        ? detail.code
        : status === 404
          ? 'resource_not_found'
          : status === 409
            ? 'conflict'
            : status >= 500
              ? 'internal_error'
              : 'invalid_request',
    message:
      typeof detail.message === 'string'
        ? detail.message
        : Array.isArray(detail.message)
          ? detail.message
              .filter((value) => typeof value === 'string')
              .join('; ')
          : error.message,
    details: Object.keys(details).length ? details : undefined,
    remediation:
      'Inspect the target session/task state and correct the input before retrying. Finished tasks must be reopened before executing work.',
    retryable: status >= 500,
  });
}

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
      : err instanceof HttpException
        ? domainError(err)
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
  if (toolError.details) error.details = toolError.details;

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
  };
}
