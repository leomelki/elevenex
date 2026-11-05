import { reportedTerminalTitle } from './terminal-title.js';

export type TerminalOutputEvent = (
  | { readonly type: 'ready' }
  | { readonly type: 'started' }
  | { readonly type: 'disabled' }
  | { readonly type: 'title'; readonly title: string | null }
  | { readonly type: 'cwd'; readonly cwd: string | null }
  | {
      readonly type: 'command';
      readonly command: string | null;
      readonly confidence: 'exact' | 'history';
    }
  | { readonly type: 'completed'; readonly code: number }
  | {
      readonly type: 'service';
      readonly port: number;
      readonly protocol: 'http' | 'https';
      readonly path: string;
    }
) & {
  /** Absolute UTF-16 offset immediately after the event. */ readonly at: number;
};

const MAX_FRAME = 33_000;
const ROOT_SERVICE =
  /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(\/)$/;
const PATH_SERVICE =
  /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(\/[^\s<>"'`\\]*)?\s$/;

/** Bounded incremental OSC parser. Every OSC (including foreign/oversize frames)
 * consumes its payload so metadata can never become a service hint. Output is
 * observed only; the PTY bytes retained for xterm are never modified. */
export class TerminalOutputEvents {
  private offset = 0;
  private escaped = false;
  private frame: string | null = null;
  private overflow = false;
  private csi: 'sgr' | 'other' | null = null;
  private plain = '';
  constructor(private readonly token: string | null) {}

  append(data: string, receive: (event: TerminalOutputEvent) => void): void {
    for (let index = 0; index < data.length; index++) {
      const char = data[index];
      this.offset++;
      if (this.frame !== null) {
        if (char === '\x07' || (this.escaped && char === '\\')) {
          if (!this.overflow) this.receiveFrame(this.frame, receive);
          this.frame = null;
          this.overflow = false;
          this.escaped = false;
        } else {
          if (this.escaped) this.overflow = true;
          this.escaped = char === '\x1b';
          if (!this.escaped && !this.overflow) {
            if (this.frame.length < MAX_FRAME) this.frame += char;
            else this.overflow = true;
          }
        }
        continue;
      }
      if (this.csi !== null && char !== '\x1b') {
        if (char >= '@' && char <= '~') {
          // SGR only changes styling. Vite inserts it inside URLs to bold the
          // port; wait for a visible delimiter so styling cannot finish :4 early.
          if (char !== 'm' || this.csi !== 'sgr') this.plain = '';
          this.csi = null;
        } else if (!/[\d;:]/.test(char)) {
          this.csi = 'other';
          this.plain = '';
        }
        continue;
      }
      if (this.csi !== null) this.plain = '';
      this.csi = null;
      if (this.escaped) {
        this.escaped = false;
        if (char === ']') {
          this.frame = '';
          this.plain = '';
          continue;
        }
        if (char === '[') {
          this.csi = 'sgr';
          continue;
        }
        this.plain = '';
      }
      if (char === '\x1b') {
        this.escaped = true;
        continue;
      }
      this.plain = (this.plain + char).slice(-2304);
      // Require a delimiter; a chunk ending with :3 may continue with 000.
      if (char > ' ' && char !== '/') continue;
      const match = (char === '/' ? ROOT_SERVICE : PATH_SERVICE).exec(
        this.plain,
      );
      if (match) {
        const port = Number(match[2]);
        if (port > 0 && port <= 65535)
          receive({
            type: 'service',
            port,
            protocol: match[1] === 'https' ? 'https' : 'http',
            // Only a pathname is a hint. Do not propagate credentials, query
            // strings, fragments or output-supplied origins into navigation.
            path: (match[3] ?? '/').split(/[?#]/, 1)[0].slice(0, 2048),
            at: this.offset,
          });
      }
    }
  }

  private receiveFrame(
    frame: string,
    receive: (event: TerminalOutputEvent) => void,
  ): void {
    // Standard OSC 0/2 titles are untrusted display hints, independent of shell
    // integration. They cannot authorize command metadata, rerun or navigation.
    const title = /^(?:0|2);(.*)$/s.exec(frame);
    if (title) {
      receive({
        type: 'title',
        title: reportedTerminalTitle(title[1]),
        at: this.offset,
      });
      return;
    }
    if (!this.token) return;
    const prefix = /^133;([BCDEHXP]);([a-f\d-]{36})(?:;(.*))?$/s.exec(frame);
    if (!prefix || prefix[2] !== this.token) return;
    const kind = prefix[1],
      raw = prefix[3],
      at = this.offset;
    if (kind === 'E' || kind === 'H')
      receive({
        type: 'command',
        command: decodeValue(raw, 4096, true),
        confidence: kind === 'E' ? 'exact' : 'history',
        at,
      });
    else if (kind === 'P')
      receive({ type: 'cwd', cwd: decodeValue(raw, 8192), at });
    else if (kind === 'D' && raw !== undefined && /^\d{1,3}$/.test(raw))
      receive({ type: 'completed', code: Math.min(255, Number(raw)), at });
    else if (raw === undefined) {
      if (kind === 'B') receive({ type: 'ready', at });
      else if (kind === 'C') receive({ type: 'started', at });
      else if (kind === 'X') receive({ type: 'disabled', at });
    }
  }
}

/** VS Code-style escaping. Display metadata can include newline/tab; rerun cannot. */
function decodeValue(
  raw: string | undefined,
  max: number,
  multiline = false,
): string | null {
  if (!raw || raw.length > max * 4 || raw.includes(';')) return null;
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
    if (value.length > max) return null;
  }
  // Reject unpaired surrogates and controls, including terminal framing.
  // eslint-disable-next-line no-control-regex -- Validate metadata received from a shell.
  const controls = multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
  return !value.trim() || controls.test(value) || /[\uD800-\uDFFF]/u.test(value)
    ? null
    : value;
}

export function repeatableCommand(command: string | null): command is string {
  // eslint-disable-next-line no-control-regex -- Never inject controls into a prompt.
  return !!command && !/[\x00-\x1f\x7f]/.test(command);
}
