import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { askSessionTool } from './ask-session.tool.js';

export const ASK_TOOLS: ToolDefinition[] = [askSessionTool];
