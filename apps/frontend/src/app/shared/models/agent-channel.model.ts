/** A richer "show this to the user" payload pushed by the meta-agent. */
export interface AgentShow {
  id: string;
  agentSessionId: number;
  title: string;
  body?: string;
  deepLink?: string;
  createdAt: string;
}
