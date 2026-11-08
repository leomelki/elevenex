/** Serialization restores cells/modes, not an unfinished VT parser sequence.
 * Retain that suffix so a checkpoint in the middle of an OSC/CSI is replayable.
 * Bound hostile unterminated control strings independently of scrollback. */
export class TerminalParserTail {
  private state: 'ground' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'ground';
  private value = '';
  private overflow = false;
  private osc = false;

  append(data: string): void {
    for (const char of data) {
      if (this.state === 'ground') {
        if (char === '\x1b') { this.state = 'escape'; this.value = char; }
        else if (char === '\x9b') { this.state = 'csi'; this.value = char; }
        else if (['\x90', '\x98', '\x9d', '\x9e', '\x9f'].includes(char)) {
          this.state = 'string'; this.osc = char === '\x9d'; this.value = char;
        }
        continue;
      }
      if (!this.overflow) {
        this.value += char;
        if (this.value.length > 65536) { this.value = ''; this.overflow = true; }
      }
      if (char === '\x18' || char === '\x1a') { this.clear(); continue; }
      if (this.state === 'escape') {
        if (char < ' ' && char !== '\x1b') { if (!this.overflow) this.value = this.value.slice(0, -1); continue; }
        if (char === '[') this.state = 'csi';
        else if (']PX^_'.includes(char)) { this.osc = char === ']'; this.state = 'string'; }
        else if (char >= '0' && char <= '~') this.clear();
      } else if (this.state === 'csi') {
        if (char === '\x1b') { this.clear(); this.state = 'escape'; this.value = char; }
        else if (char >= '@' && char <= '~') this.clear();
        // C0 controls execute immediately inside CSI. Replaying them after the
        // serialized cursor would apply them twice.
        else if (char < ' ' && !this.overflow) this.value = this.value.slice(0, -1);
      } else if (this.state === 'string') {
        if (char === '\x1b') this.state = 'stringEscape';
        else if (char === '\x9c' || (char === '\x07' && this.osc)) this.clear();
      } else {
        if (char === '\\') this.clear();
        else if (char !== '\x1b') this.state = 'string';
      }
    }
  }
  suffix(): string {
    if (this.overflow) throw new Error('A terminal control sequence is incomplete and too large to restore.');
    return this.value;
  }
  private clear(): void { this.state = 'ground'; this.value = ''; this.overflow = false; }
}
