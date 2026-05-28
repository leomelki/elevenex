import { generateTmuxScrollConfig } from './tmux-scroll-config.js';

describe('generateTmuxScrollConfig', () => {
  function getRootWheelUpBinding(): string {
    const rootWheelUp = generateTmuxScrollConfig()
      .split('\n')
      .find((line) => line.includes('-T root WheelUpPane'));

    expect(rootWheelUp).toBeDefined();
    return rootWheelUp!;
  }

  it('does not enter tmux copy-mode from wheel scrolling while alternate screen is active', () => {
    const rootWheelUp = getRootWheelUpBinding();

    expect(rootWheelUp).toContain('#{alternate_on}');
    expect(rootWheelUp).toContain('#{!=:#{alternate_on},1}');
  });

  it('only enters tmux copy-mode from wheel scrolling while a shell owns the pane', () => {
    const rootWheelUp = getRootWheelUpBinding();

    expect(rootWheelUp).toContain('#{pane_current_command}');
    expect(rootWheelUp).toContain(
      '#{m/r:^(sh|bash|zsh|fish|dash|ksh|mksh|csh|tcsh|nu|pwsh|powershell)$,#{pane_current_command}}',
    );
    expect(rootWheelUp).toContain(
      'if-shell -Ft= \\"#{&&:#{!=:#{alternate_on},1},#{m/r:^(sh|bash|zsh|fish|dash|ksh|mksh|csh|tcsh|nu|pwsh|powershell)$,#{pane_current_command}}}\\" \\"copy-mode -e ; send-keys -X -N 1 scroll-up\\" \\"\\"',
    );
  });
});
