import { DefaultAgentProvider } from './app-settings.model';

export interface AgentProviderPresentation {
  id: DefaultAgentProvider;
  label: string;
  /** `@ng-icons/lucide` export name. Register it wherever this list renders. */
  icon: string;
}

/**
 * How the agent providers are labelled in the settings and onboarding pickers.
 *
 * This is the single place a newly supported provider has to be named for the
 * chooser UIs, so those templates stay `@for` loops instead of growing another
 * hand-written block each time.
 *
 * Per-session UI (the workspace status bar, the model catalog) does not use this
 * list at all — it renders whatever `GET /api/agent-providers` reports, so an
 * unknown provider still works there.
 */
export const AGENT_PROVIDER_PRESENTATIONS: readonly AgentProviderPresentation[] =
  [
    { id: 'claude', label: 'Claude', icon: 'lucideSparkles' },
    { id: 'codex', label: 'Codex', icon: 'lucideFileText' },
    { id: 'pi', label: 'Pi', icon: 'lucideNotebookPen' },
    { id: 'gemini', label: 'Gemini', icon: 'lucideGem' },
  ] as const;

/** Icon lookup for provider ids reported by the backend. */
export const AGENT_PROVIDER_ICONS: Record<string, string> =
  Object.fromEntries(
    AGENT_PROVIDER_PRESENTATIONS.map((provider) => [
      provider.id,
      provider.icon,
    ]),
  );
