export function formatMessageTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  if (now.toDateString() === date.toDateString()) return time;
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear() === date.getFullYear() ? '' : `/${date.getFullYear()}`;
  return `${day}/${month}${year} ${time}`;
}
