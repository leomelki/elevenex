import { expect, test } from '@playwright/test';

// Exercise the real terminal renderer with deterministic PTY output, without
// launching shells or agent processes in the user's worktrees.
for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: terminal views reopen without reconnecting and retain output and selection`, async ({ page }) => {
    await page.route('**/vscode-static/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Mock editor</title>',
    }));
    await page.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (pathname === '/api/settings') {
        json = { onboardingCompletedAt: '2026-01-01T00:00:00Z' };
      } else if (pathname === '/api/sessions/17') {
        json = {
          id: 17, repoId: 1, projectId: 1, name: 'Terminal regression',
          branchName: 'main', worktreePath: '/terminal-test', status: 'stopped',
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
    let terminalConnections = 0;
    let sendTerminalOutput: ((data: string) => void) | undefined;
    let exitTerminal: (() => void) | undefined;
    let agentConnections = 0;
    let sendAgentOutput: ((data: string) => void) | undefined;
    await page.routeWebSocket('**/*', (socket) => {
      const pathname = new URL(socket.url()).pathname;
      // API requests wait for backend readiness. Keep that handshake alive
      // while leaving agent sockets mocked so no real processes are launched.
      if (pathname === '/server-connection') {
        const sendReady = () => socket.send(JSON.stringify({
          type: 'ready', serverTime: new Date().toISOString(),
        }));
        sendReady();
        const heartbeat = setInterval(sendReady, 1000);
        heartbeat.unref();
        socket.onClose(() => clearInterval(heartbeat));
        page.on('close', () => clearInterval(heartbeat));
        return;
      }
      if (pathname === '/') {
        // Angular's dev-server socket must still receive its Vite handshake.
        socket.connectToServer();
        return;
      }
      if (pathname === '/terminal') {
        agentConnections += 1;
        sendAgentOutput = data => socket.send(data);
        socket.onMessage(message => {
          if (typeof message === 'string' && message.includes('"resize"')) socket.send('agent-terminal-ready\r\n');
        });
        return;
      }
      if (pathname !== '/user-terminal') return;
      terminalConnections += 1;
      sendTerminalOutput = data => socket.send(data);
      exitTerminal = () => socket.close({ code: 4000, reason: 'Terminal process exited' });
      let sent = false;
      socket.onMessage((message) => {
        // Wait for fitting/resizing before sending more output than fits onscreen.
        if (sent || typeof message !== 'string' || !message.includes('"resize"')) return;
        sent = true;
        // A restarted shell produces fresh output, rather than replaying the
        // same history markers into the renderer's retained scrollback.
        socket.send(terminalConnections === 1
          ? Array.from({ length: 120 }, (_, i) => `history-${i}\r\n`).join('')
          : 'restarted-shell-ready\r\n');
      });
    });

    await page.goto('/sessions/17');
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Toggle Terminal panel', exact: true }).click();
    const terminal = page.locator('app-user-terminal-view');
    const rows = terminal.locator('.xterm-rows');
    await expect(rows).toContainText('history-119');
    await expect(rows).not.toContainText('history-0');

    // Reopening must reuse the socket and renderer, including output received
    // while the panel is closed, instead of handshaking and replaying history.
    const toggle = page.getByRole('button', { name: 'Toggle Terminal panel', exact: true });
    for (let reopen = 0; reopen < 3; reopen++) {
      await toggle.click();
      await expect(terminal).toHaveCount(0);
      sendTerminalOutput?.(`hidden-output-${reopen}\r\n`);
      await toggle.click();
      await expect(rows).toContainText(`hidden-output-${reopen}`);
      await expect(terminal.getByText('Connecting', { exact: true })).toHaveCount(0);
      expect(terminalConnections).toBe(1);
    }

    // Shell exit must stop retries. Explicitly reopening starts a new shell
    // while keeping the cached renderer and its existing scrollback.
    exitTerminal!();
    await expect(terminal.getByText('Disconnected', { exact: true })).toBeVisible();
    expect(terminalConnections).toBe(1);
    await toggle.click();
    await expect(terminal).toHaveCount(0);
    await toggle.click();
    await expect(terminal.getByText('Disconnected', { exact: true })).toHaveCount(0);
    await expect(rows).toContainText('restarted-shell-ready');
    await expect(rows).toContainText('history-119');
    expect(terminalConnections).toBe(2);

    // Test both the keyboard and actual wheel path through xterm's viewport.
    await terminal.locator('.xterm-screen').click();
    await terminal.locator('.xterm-helper-textarea').press('Shift+PageUp');
    await expect(rows).not.toContainText('history-119');
    await terminal.locator('.xterm-screen').hover();
    // xterm limits how far each wheel event scrolls; keep exercising the real
    // wheel path until the oldest line is rendered instead of assuming a delta.
    await expect.poll(async () => {
      await page.mouse.wheel(0, -10000);
      return rows.locator(':scope > div').first().textContent();
    }).toBe('history-0');

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

    // The raw agent Terminal UI uses a separate transport and must also survive
    // switching back to workspace UI without losing its renderer or socket.
    await toggle.click();
    await page.getByRole('button', { name: 'Switch to Claude raw terminal fallback', exact: true }).click();
    const agent = page.locator('app-claude-terminal');
    const agentRows = agent.locator('.xterm-rows');
    await expect(agentRows).toContainText('agent-terminal-ready');
    for (let reopen = 0; reopen < 3; reopen++) {
      await page.getByRole('button', { name: 'Return to workspace UI', exact: true }).click();
      await expect(agent).toHaveCount(0);
      sendAgentOutput?.(`agent-hidden-output-${reopen}\r\n`);
      await page.getByRole('button', { name: 'Switch to Claude raw terminal fallback', exact: true }).click();
      await expect(agentRows).toContainText(`agent-hidden-output-${reopen}`);
      await expect(agent.getByText('Connecting', { exact: true })).toHaveCount(0);
      expect(agentConnections).toBe(1);
    }
  });
}
