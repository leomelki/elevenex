/**
 * Generates tmux config for scroll behavior:
 * - 1-line smooth scroll via mouse wheel
 * - Auto-exit copy-mode on any keyboard input (cancel + forward key)
 */
export function generateTmuxScrollConfig(): string {
  const lines: string[] = [];

  // --- Enable OSC 52 clipboard: tmux sends copied text to the parent terminal ---
  lines.push('set -s set-clipboard on');

  // --- Scroll bindings: 1-line per wheel tick ---
  lines.push(
    'bind-key -T copy-mode WheelUpPane select-pane \\; send-keys -X -N 1 scroll-up',
    'bind-key -T copy-mode WheelDownPane select-pane \\; send-keys -X -N 1 scroll-down',
    'bind-key -T copy-mode-vi WheelUpPane select-pane \\; send-keys -X -N 1 scroll-up',
    'bind-key -T copy-mode-vi WheelDownPane select-pane \\; send-keys -X -N 1 scroll-down',
  );

  // Root table: enter copy-mode on scroll up with 1-line scroll
  lines.push(
    `bind-key -T root WheelUpPane if-shell -Ft= "#{mouse_any_flag}" "send-keys -M" "if-shell -Ft= '#{pane_in_mode}' 'send-keys -X -N 1 scroll-up' 'copy-mode -e ; send-keys -X -N 1 scroll-up'"`,
    `bind-key -T root WheelDownPane if-shell -Ft= "#{mouse_any_flag}" "send-keys -M" "if-shell -Ft= '#{pane_in_mode}' 'send-keys -X -N 1 scroll-down' ''"`,
  );

  // --- Auto-exit copy-mode on any keypress ---
  // Bind every common key in both copy-mode tables to: cancel + forward key
  // This hides the fact that tmux copy-mode is being used.

  const addCancel = (keyName: string, forward: string) => {
    lines.push(`bind-key -T copy-mode ${keyName} send-keys -X cancel \\; ${forward}`);
    lines.push(`bind-key -T copy-mode-vi ${keyName} send-keys -X cancel \\; ${forward}`);
  };

  const addCancelOnly = (keyName: string) => {
    lines.push(`bind-key -T copy-mode ${keyName} send-keys -X cancel`);
    lines.push(`bind-key -T copy-mode-vi ${keyName} send-keys -X cancel`);
  };

  // Letters a-z, A-Z
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    addCancel(lower, `send-keys -l '${lower}'`);
    addCancel(upper, `send-keys -l '${upper}'`);
  }

  // Digits 0-9
  for (let i = 0; i <= 9; i++) {
    addCancel(String(i), `send-keys -l '${i}'`);
  }

  // Safe symbols (key name = literal character)
  const safeSymbols = ['-', '_', '=', '+', ',', '.', '/', ':', '@', '!', '%', '^', '&', '*', '(', ')', '[', ']', '|', '`', '<', '>', '?'];
  for (const sym of safeSymbols) {
    addCancel(sym, `send-keys -l '${sym}'`);
  }

  // Symbols needing escaped/quoted key names
  addCancel('\\#', `send-keys -l '#'`);
  addCancel('\\$', `send-keys -l '$'`);
  addCancel('\\{', `send-keys -l '{'`);
  addCancel('\\}', `send-keys -l '}'`);
  addCancel('\\\\', `send-keys -l '\\\\'`);
  addCancel('\\;', `send-keys -l ';'`);
  addCancel("'~'", `send-keys -l '~'`);

  // Named special keys (forward as key names, not literals)
  addCancel('Enter', 'send-keys Enter');
  addCancel('Space', 'send-keys Space');
  addCancel('BSpace', 'send-keys BSpace');
  addCancel('Tab', 'send-keys Tab');
  addCancel('Up', 'send-keys Up');
  addCancel('Down', 'send-keys Down');
  addCancel('Left', 'send-keys Left');
  addCancel('Right', 'send-keys Right');
  addCancel('NPage', 'send-keys NPage');
  addCancel('PPage', 'send-keys PPage');
  addCancel('Home', 'send-keys Home');
  addCancel('End', 'send-keys End');
  addCancel('DC', 'send-keys DC');

  // Escape just cancels (no forwarding — acts as "exit scroll view")
  addCancelOnly('Escape');

  // Ctrl combinations
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(97 + i);
    addCancel(`C-${letter}`, `send-keys C-${letter}`);
  }

  // Ctrl+Arrow and Alt combos
  addCancel('C-Up', 'send-keys C-Up');
  addCancel('C-Down', 'send-keys C-Down');
  addCancel('M-x', 'send-keys M-x');

  return lines.join('\n') + '\n';
}
