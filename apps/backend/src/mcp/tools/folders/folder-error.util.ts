import { ToolError } from '../../tool-registry/tool.types.js';

export function sessionFolderError(
  code: string,
  error: unknown,
  remediation: string,
): ToolError {
  return new ToolError({
    code,
    message:
      error instanceof Error
        ? error.message
        : 'Session folder operation failed.',
    remediation,
  });
}
