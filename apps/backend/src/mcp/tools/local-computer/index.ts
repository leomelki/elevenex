import type { ToolDefinition } from '../../tool-registry/tool.types.js';
import { runLocalBashTool } from './run-local-bash.tool.js';

export const LOCAL_COMPUTER_TOOLS: ToolDefinition[] = [runLocalBashTool];
