import { generateTmuxScrollConfig } from './tmux-scroll-config.js';

describe('generateTmuxScrollConfig', () => {
  it('does not enter tmux copy-mode from wheel scrolling while alternate screen is active', () => {
    const rootWheelUp = generateTmuxScrollConfig()
      .split('\n')
      .find((line) => line.includes('-T root WheelUpPane'));

    expect(rootWheelUp).toContain('#{alternate_on}');
    expect(rootWheelUp).toContain(
      'if-shell -Ft= \\"#{alternate_on}\\" \\"\\" \\"copy-mode -e ; send-keys -X -N 1 scroll-up\\"',
    );
  });
});
