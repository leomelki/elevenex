/** Shared MCP contract for every agent provider and the configuration manager. */
export type McpScope = 'project' | 'local' | 'user' | 'enterprise' | 'runtime';

export type McpTransport =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'ws'
  | 'sdk'
  | 'claudeai-proxy'
  | 'unknown';

export type McpConnectionStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'disabled'
  | 'unknown';

export type McpConfigStatus = 'valid' | 'warning' | 'error';

export interface McpServerEntry {
  origin?: 'configuration' | 'sdk' | 'plugin';
  endpoint?: string;
  revision?: string;
  shadowed?: boolean;
  entryId: string;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  configLocation: string;
  enabled: boolean;
  connectionStatus: McpConnectionStatus;
  configStatus: McpConfigStatus;
  error?: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  counts?: {
    tools: number;
    resources: number;
    prompts: number;
    loadedContextTools: number;
  };
  tools?: {
    name: string;
    displayName: string;
  }[];
  actions: {
    canEdit?: boolean;
    canRemove?: boolean;
    canToggle: boolean;
    canRecheck: boolean;
    canAuth: boolean;
    canReauth: boolean;
    canViewTools: boolean;
  };
}

export interface McpDiagnosticMessage {
  serverName?: string;
  path?: string;
  message: string;
}

export interface McpDiagnosticGroup {
  scope: McpScope;
  configLocation: string;
  errors: McpDiagnosticMessage[];
  warnings: McpDiagnosticMessage[];
}

export interface McpSnapshot {
  servers: McpServerEntry[];
  diagnostics: McpDiagnosticGroup[];
  summary: {
    connected: number;
    needsAuth: number;
    failed: number;
    disabled: number;
    malformed: number;
    total: number;
  };
  lastUpdatedAt: string;
  provider?: string;
  availableScopes?: ('project' | 'user' | 'local')[];
  availableTransports?: ('stdio' | 'http' | 'sse')[];
  notice?: string;
  reloadRequired?: boolean;
}

export interface McpAuthStartResult {
  serverName: string;
  url: string;
  mode: 'external';
  message: string;
}
