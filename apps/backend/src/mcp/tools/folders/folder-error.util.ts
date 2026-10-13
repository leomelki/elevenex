import { ToolError } from '../../tool-registry/tool.types.js';
import { HttpException } from '@nestjs/common';

export function sessionFolderError(
  code: string,
  error: unknown,
  remediation: string,
): ToolError {
  if (error instanceof ToolError) return error;
  const response = error instanceof HttpException ? error.getResponse() : null;
  const domainCode =
    response &&
    typeof response === 'object' &&
    'code' in response &&
    typeof response.code === 'string'
      ? response.code
      : code;
  return new ToolError({
    code: domainCode,
    message:
      error instanceof Error
        ? error.message
        : 'Session folder operation failed.',
    remediation:
      domainCode === 'self_target_not_allowed'
        ? 'Continue in the calling conversation; ask the human to stop or delete it after this turn.'
        : remediation,
  });
}
