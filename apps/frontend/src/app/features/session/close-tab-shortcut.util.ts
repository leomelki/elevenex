type KeyboardShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;
type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
};

export function getPlatformIdentifier(): string | null {
  if (typeof navigator === 'undefined') {
    return null;
  }

  const browserNavigator = navigator as NavigatorWithUserAgentData;
  return browserNavigator.userAgentData?.platform ?? browserNavigator.platform ?? null;
}

export function shouldCloseActiveSessionTab(
  event: KeyboardShortcutEvent,
  platform = getPlatformIdentifier(),
): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'w') {
    return false;
  }

  if (platform?.startsWith('Mac')) {
    return event.metaKey && !event.ctrlKey;
  }

  if (platform?.startsWith('Win')) {
    return event.ctrlKey && !event.metaKey;
  }

  return false;
}
