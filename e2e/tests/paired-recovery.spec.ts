import { expect, test, type Page } from '@playwright/test';

// Exercise the real startup and server gateway, controlling only desktop IPC
// and network responses so no second desktop or pairing credentials are needed.
async function preparePairedWindow(page: Page, theme: 'light' | 'dark') {
  await page.route('**/api/**', route => route.fulfill({
    json: route.request().url().includes('/settings')
      ? { onboardingCompletedAt: '2026-01-01T00:00:00Z' }
      : [],
  }));
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('elevenex-theme', theme);
    localStorage.setItem('elevenex-onboarding-session@w0', JSON.stringify({
      mode: 'paired', currentStep: 'project', activeServerId: null,
      remoteConnectionReady: true, projectHandoffAcknowledged: true,
      wsl: null, paired: { id: 3, name: 'Studio', localPort: 51234 },
    }));
    window.__ELEVENEX_RUNTIME__ = { mode: 'electron-debug', windowId: 'w0' };
    const device = {
      id: 3, name: 'Studio', transport: 'p2p', endpoint: '',
      createdAt: '2026-01-01', lastConnectedAt: '2026-01-01',
      status: 'stopped', localPort: null as number | null, backendUrl: null as string | null,
      path: 'direct', error: null,
    };
    const control = {
      calls: 0, ready: false, finish: () => {},
      status: (_device: typeof device) => {},
    };
    (window as any).__pairedTest = control;
    window.__ELEVENEX_ELECTRON__ = {
      remoteLink: {
        getSharing: async () => ({ configured: false, enabled: false, status: 'stopped', connectedPeers: 0 }),
        list: async () => [device],
        onSharingChanged: () => () => {},
        onStatusChanged: (callback: typeof control.status) => { control.status = callback; return () => {}; },
        connect: async () => {
          control.calls++;
          if (!control.ready) await new Promise<void>(resolve => { control.finish = resolve; });
          device.status = 'connected';
          device.localPort = 51999;
          device.backendUrl = 'http://127.0.0.1:51999';
          control.status({ ...device });
          return { ...device };
        },
      },
    } as any;
  }, { theme });
  await page.routeWebSocket('**/server-connection', socket => {
    socket.send(JSON.stringify({ type: 'ready', serverTime: new Date().toISOString() }));
  });
  await page.goto('/projects');
  const overlay = page.getByRole('alertdialog', { name: 'Server disconnected' });
  await expect(overlay).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pairedTest.calls)).toBe(1);
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
  else await expect(page.locator('html')).not.toHaveClass(/dark/);
  return overlay;
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: restored paired link opens its first server socket on the new port`, async ({ page }) => {
    const overlay = await preparePairedWindow(page, theme);
    const requests: string[] = [];
    page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()); });
    await page.evaluate(() => {
      (window as any).__pairedTest.ready = true;
      (window as any).__pairedTest.finish();
    });
    await expect(overlay).toBeHidden();
    await expect(page).toHaveURL(/\/projects$/);
    await expect.poll(() => requests.some(url => url.startsWith('http://127.0.0.1:51999/api/'))).toBe(true);
    expect(requests.some(url => url.includes(':51234/'))).toBe(false);
    expect(await page.evaluate(() => (window as any).__pairedTest.calls)).toBe(1);
  });

  test(`${theme}: disconnected paired window offers an accessible local escape`, async ({ page }) => {
    const overlay = await preparePairedWindow(page, theme);
    const retry = overlay.getByRole('button', { name: 'Retry connection' });
    const local = overlay.getByRole('button', { name: 'Use local workspace' });
    await expect(retry).toBeEnabled();
    await local.focus();
    await expect(local).toBeFocused();
    expect(await local.evaluate(button => getComputedStyle(button).boxShadow)).not.toBe('none');
    await page.screenshot({ path: `artifacts/paired-disconnected-${theme}.png` });
    await local.click();
    await expect(overlay).toBeHidden();
    // A late IPC response must not pull the window back onto the paired device.
    await page.evaluate(() => (window as any).__pairedTest.finish());
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('elevenex-onboarding-session@w0')!).mode)).toBe('local');
  });
}
