import { expect, test } from '@playwright/test';

// Exercise the real terminal renderer with deterministic PTY output, without
// launching shells or agent processes in the user's worktrees.
for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: user terminal retains scrollback and renders selected text`, async ({ page }) => {
    await page.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (pathname === '/api/settings') {
        json = { onboardingCompletedAt: '2026-01-01T00:00:00Z' };
      } else if (pathname === '/api/sessions/17') {
        json = {
          id: 17, repoId: 1, projectId: 1, name: 'Terminal regression',
          branchName: 'main', worktreePath: '/terminal-test', status: 'archived',
          activeAgentProvider: 'claude', claudeSessionId: '', codexSessionId: '',
          hasInjectedWorktreeContext: false, hasUnreviewedCompletion: false,
          lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: null,
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
        };
      } else if (pathname === '/api/user-terminals') {
        json = [{ id: 1, name: 'Test shell', shell: '/bin/sh', worktreePath: '/terminal-test' }];
      }
      return route.fulfill({ json });
    });
    await page.addInitScript((theme) => {
      window.__ELEVENEX_RUNTIME__ = { mode: 'browser', windowId: 'w0' };
      localStorage.setItem('elevenex-theme', theme);
      localStorage.setItem('elevenex-onboarding-session@w0', JSON.stringify({
        mode: 'local', currentStep: 'project', activeServerId: null,
        remoteConnectionReady: true, projectHandoffAcknowledged: true,
        wsl: null, paired: null,
      }));
    }, theme);
    await page.routeWebSocket('**/*', (socket) => {
      if (!new URL(socket.url()).pathname.endsWith('/user-terminal')) return;
      let sent = false;
      socket.onMessage((message) => {
        // Wait for fitting/resizing before sending more output than fits onscreen.
        if (sent || typeof message !== 'string' || !message.includes('"resize"')) return;
        sent = true;
        socket.send(Array.from({ length: 120 }, (_, i) => `history-${i}\r\n`).join(''));
      });
    });

    await page.goto('/sessions/17');
    await page.getByRole('button', { name: 'Toggle Terminal panel', exact: true }).click();
    const terminal = page.locator('app-user-terminal-view');
    const rows = terminal.locator('.xterm-rows');
    await expect(rows).toContainText('history-119');
    await expect(rows).not.toContainText('history-0');

    // Test both the keyboard and actual wheel path through xterm's viewport.
    await terminal.locator('.xterm-screen').click();
    await terminal.locator('.xterm-helper-textarea').press('Shift+PageUp');
    await expect(rows).not.toContainText('history-119');
    await terminal.locator('.xterm-screen').hover();
    await page.mouse.wheel(0, -10000);
    await expect(rows).toContainText('history-0');

    // xterm uses xterm-decoration-top on selected glyphs. They must stay visible.
    await terminal.locator('.xterm-helper-textarea').press('Control+Shift+KeyA');
    const selectedText = terminal.locator('.xterm-rows .xterm-decoration-top').first();
    await expect(selectedText).toBeVisible();
    await expect(selectedText).toContainText('history-0');
    const focusedColors = await selectedText.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor };
    });
    expect(focusedColors.color).not.toBe(focusedColors.background);

    await page.getByRole('button', { name: 'Toggle Terminal panel', exact: true }).focus();
    await expect(selectedText).toBeVisible();
    await expect(selectedText).toContainText('history-0');
  });
}
