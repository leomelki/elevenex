import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';

/** MCP defaults omitted mode to form. An explicit empty object form can be
 * confirmed with {}, while a missing schema provides no such capability. */
export function claudeElicitationDecision(
  request: ElicitationRequest,
): 'confirm' | 'unsupported' | undefined {
  if (request.mode === 'url') {
    return typeof request.url === 'string' && request.url.trim()
      ? undefined
      : 'unsupported';
  }
  if ((request.mode !== undefined && request.mode !== 'form') || request.url !== undefined)
    return 'unsupported';

  const schema = request.requestedSchema;
  const properties = schema?.properties;
  if (schema?.type !== 'object' || !properties ||
      typeof properties !== 'object' || Array.isArray(properties))
    return 'unsupported';
  if (Object.keys(properties).length) return undefined;
  const required = schema.required;
  const constraints = Object.keys(schema).filter(
    key => !['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema'].includes(key),
  );
  return (required === undefined || (Array.isArray(required) && required.length === 0)) &&
    (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean') &&
    constraints.length === 0 &&
    typeof request.message === 'string' && request.message.trim().length > 0
    ? 'confirm'
    : 'unsupported';
}
