export type TerminalOutputEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'started' }
  | { readonly type: 'disabled' }
  | { readonly type: 'command'; readonly command: string | null }
  | { readonly type: 'completed'; readonly code: number }
  | {
      readonly type: 'service';
      readonly port: number;
      readonly protocol: 'http' | 'https';
    };

const MAX_FRAME = 16_512;

/** Optional metadata only. Output bytes always reach the terminal unchanged. */
export class TerminalOutputEvents {
  private tail = '';
  constructor(private readonly token: string | null) {}

  append(data: string, receive: (event: TerminalOutputEvent) => void): void {
    const retained = this.tail.length;
    const text = this.tail + data;
    // Process command/status frames and service hints in wire order. A command
    // frame consumes its entire payload so URLs inside it cannot become hints.
    const events =
      // eslint-disable-next-line no-control-regex -- PTY escape protocol delimiters.
      /\x1b\]133;([BCDEX]);([a-f\d-]{36})(?:;([^\x07\x1b]{0,16384}))?(?:\x07|\x1b\\)|(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?=[/\s\x1b]|$)/g;
    for (const match of text.matchAll(events)) {
      if ((match.index ?? 0) + match[0].length <= retained) continue;
      if (!match[1]) {
        const port = Number(match[5]);
        if (port > 0 && port <= 65535)
          receive({
            type: 'service',
            port,
            protocol: match[4] === 'https' ? 'https' : 'http',
          });
      } else if (match[2] === this.token) {
        const payload = match[3];
        if (match[1] === 'E')
          receive({ type: 'command', command: decodeCommand(payload) });
        else if (
          match[1] === 'D' &&
          payload !== undefined &&
          /^\d{1,3}$/.test(payload)
        )
          receive({ type: 'completed', code: Math.min(255, Number(payload)) });
        else if (payload === undefined) {
          if (match[1] === 'B') receive({ type: 'ready' });
          else if (match[1] === 'C') receive({ type: 'started' });
          else if (match[1] === 'X') receive({ type: 'disabled' });
        }
      }
    }
    const start = text.lastIndexOf('\x1b]133;');
    const suffix = start < 0 ? '' : text.slice(start);
    this.tail =
      suffix && !suffix.includes('\x07') && !suffix.includes('\x1b\\')
        ? suffix.slice(0, MAX_FRAME)
        : text.slice(-100);
  }
}

/** VS Code-style escaping, with a stricter executable single-line subset. */
function decodeCommand(raw: string | undefined): string | null {
  if (!raw || raw.length > 16384 || raw.includes(';')) return null;
  let value = '';
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char !== '\\') value += char;
    else if (raw[index + 1] === '\\') {
      value += '\\';
      index++;
    } else if (
      raw[index + 1] === 'x' &&
      /^[a-f\d]{2}$/i.test(raw.slice(index + 2, index + 4))
    ) {
      value += String.fromCharCode(
        Number.parseInt(raw.slice(index + 2, index + 4), 16),
      );
      index += 3;
    } else return null;
    if (value.length > 4096) return null;
  }
  // Never inject controls, partial Unicode, multiline input or framing into a shell.
  // eslint-disable-next-line no-control-regex -- Validate the command protocol's safe subset.
  const hasControls = /[\x00-\x1f\x7f]/.test(value);
  return !value.trim() || hasControls || /[\uD800-\uDFFF]/u.test(value)
    ? null
    : value;
}
