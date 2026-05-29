export interface SessionToolbarButtonPreference {
  id: string;
  visible: boolean;
}

export interface SessionToolbarButtonDefinition {
  id: string;
  label: string;
  description: string;
  iconName: string;
}

export const SESSION_TOOLBAR_BUTTON_DEFINITIONS = [
  {
    id: 'agent',
    label: 'Agent',
    description: 'Open the session agent drawer.',
    iconName: 'lucideSparkles',
  },
  {
    id: 'plannotator',
    label: 'Plannotator',
    description: 'Toggle the Plannotator side panel when available.',
    iconName: 'lucideNotebookPen',
  },
  {
    id: 'planReview',
    label: 'Plan review',
    description: 'Open pending plan review feedback.',
    iconName: 'lucideClipboardList',
  },
  {
    id: 'claudeTerminal',
    label: 'Claude terminal',
    description: 'Switch between workspace UI and Claude raw terminal.',
    iconName: 'lucideSquareTerminal',
  },
  {
    id: 'terminalMirror',
    label: 'Terminal mirror',
    description: 'Show the terminal transcript mirror in raw terminal mode.',
    iconName: 'lucidePanelRight',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    description: 'Toggle the worktree terminal panel.',
    iconName: 'lucideTerminal',
  },
  {
    id: 'actions',
    label: 'Actions',
    description: 'Toggle the action runner panel.',
    iconName: 'lucidePlay',
  },
  {
    id: 'changes',
    label: 'Changes',
    description: 'Toggle the change review panel.',
    iconName: 'lucideGitPullRequest',
  },
  {
    id: 'files',
    label: 'Files',
    description: 'Toggle the files panel.',
    iconName: 'lucideFolderTree',
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Toggle the browser panel.',
    iconName: 'lucideGlobe',
  },
  {
    id: 'scratchpad',
    label: 'Scratchpad',
    description: 'Toggle the project scratchpad.',
    iconName: 'lucideFileText',
  },
  {
    id: 'todos',
    label: 'Tasks',
    description: 'Toggle the project task panel.',
    iconName: 'lucideCheckSquare',
  },
] as const satisfies readonly SessionToolbarButtonDefinition[];

export const SESSION_TOOLBAR_BUTTON_DEFINITION_MAP: ReadonlyMap<
  string,
  SessionToolbarButtonDefinition
> = new Map(
  SESSION_TOOLBAR_BUTTON_DEFINITIONS.map((definition) => [
    definition.id,
    definition,
  ]),
);

export function defaultSessionToolbarButtons(): SessionToolbarButtonPreference[] {
  return SESSION_TOOLBAR_BUTTON_DEFINITIONS.map((definition) => ({
    id: definition.id,
    visible: true,
  }));
}

export function normalizeSessionToolbarButtons(
  value: unknown,
): SessionToolbarButtonPreference[] {
  const knownIds = new Set(
    SESSION_TOOLBAR_BUTTON_DEFINITIONS.map((definition) => definition.id),
  );
  const seenIds = new Set<string>();
  const normalized: SessionToolbarButtonPreference[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        typeof item !== 'object' ||
        item === null ||
        !('id' in item) ||
        !('visible' in item) ||
        typeof item.id !== 'string' ||
        typeof item.visible !== 'boolean' ||
        !knownIds.has(item.id) ||
        seenIds.has(item.id)
      ) {
        continue;
      }

      seenIds.add(item.id);
      normalized.push({
        id: item.id,
        visible: item.visible,
      });
    }
  }

  for (const definition of SESSION_TOOLBAR_BUTTON_DEFINITIONS) {
    if (!seenIds.has(definition.id)) {
      normalized.push({
        id: definition.id,
        visible: true,
      });
    }
  }

  return normalized;
}

export function normalizeStoredSessionToolbarButtons(
  value: unknown,
): SessionToolbarButtonPreference[] | null {
  return Array.isArray(value) ? normalizeSessionToolbarButtons(value) : null;
}
