const TASK_NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g;

export type TaskNotificationStatus = 'completed' | 'failed' | 'stopped';

export interface TaskNotification {
  taskId: string;
  toolUseId: string | null;
  outputFile: string | null;
  status: TaskNotificationStatus;
  summary: string;
}

export interface ParsedTaskNotifications {
  text: string;
  notifications: TaskNotification[];
}

const VALID_STATUSES: ReadonlySet<TaskNotificationStatus> = new Set([
  'completed',
  'failed',
  'stopped',
]);

export function parseTaskNotifications(value: string | null | undefined): ParsedTaskNotifications {
  const source = value ?? '';
  const notifications: TaskNotification[] = [];
  const text = source.replace(TASK_NOTIFICATION_PATTERN, (_match, inner: string) => {
    const notification = parseNotificationBlock(inner);
    if (notification) notifications.push(notification);
    return '';
  });
  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    notifications,
  };
}

function parseNotificationBlock(inner: string): TaskNotification | null {
  const taskId = extractTag(inner, 'task-id');
  const summary = extractTag(inner, 'summary');
  if (!taskId || !summary) return null;
  const rawStatus = extractTag(inner, 'status') ?? '';
  const status: TaskNotificationStatus = VALID_STATUSES.has(rawStatus as TaskNotificationStatus)
    ? (rawStatus as TaskNotificationStatus)
    : 'completed';
  return {
    taskId,
    toolUseId: extractTag(inner, 'tool-use-id'),
    outputFile: extractTag(inner, 'output-file'),
    status,
    summary,
  };
}

function extractTag(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return match ? match[1].trim() || null : null;
}
