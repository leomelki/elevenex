import { expect, test, type Page } from '@playwright/test';

// Keep the real renderer and its services; control the desktop IPC boundary so
// network loss, late responses and cancellation are reproducible without SSH credentials.
async function prepareRemoteWindow(page: Page, theme: 'light' | 'dark', initialMode: 'hang' | 'error' | 'password') {
  await page.route('**/api/**', (route) => route.fulfill({
    json: route.request().url().includes('/settings')
      ? { onboardingCompletedAt: '2026-01-01T00:00:00Z' }
      : [],
  }));
  await page.addInitScript(({ theme, initialMode }) => {
    const server = {
      id: 17, name: 'SSH test server', sshHost: 'example.test', sshUser: 'deploy', sshPort: 22,
      authMode: initialMode === 'password' ? 'password' : 'agent', identityFilePath: null, localPort: 43100, remotePort: 11111,
      installStatus: 'available', createdAt: '2026-01-01', updatedAt: '2026-01-01', lastConnectedAt: '2026-01-01',
    };
    localStorage.setItem('elevenex-theme', theme);
    localStorage.setItem('elevenex-environments', JSON.stringify({ servers: [server], lastSshDefaults: null }));
    localStorage.setItem('elevenex-onboarding-session@w0', JSON.stringify({
      mode: 'ssh', currentStep: 'project', activeServerId: 17, remoteConnectionReady: true,
      projectHandoffAcknowledged: true, wsl: null, paired: null,
    }));
    window.__ELEVENEX_RUNTIME__ = { mode: 'electron-debug', windowId: 'w0' };
    const control = { mode: (initialMode === 'password' ? 'error' : initialMode) as 'hang' | 'error' | 'ready', calls: 0, canceled: 0, password: '', finish: (_value: unknown) => {} };
    (window as any).__sshTest = control;
    window.__ELEVENEX_ELECTRON__ = {
      sshForwarding: {
        isSupported: async () => true,
        getState: async () => ({ id: 17, status: control.mode === 'ready' ? 'active' : 'inactive' }),
      },
      remoteServer: {
        onPhaseUpdate: () => () => {},
        onInstallerEvent: () => () => {},
        cancel: async () => { control.canceled++; return true; },
        ensureReady: async (payload: any) => {
          control.calls++;
          control.password = payload.password;
          if (control.mode === 'hang') return new Promise((resolve) => { control.finish = resolve; });
          return control.mode === 'ready'
            ? { status: 'ready', localPort: 43100, installStatus: 'available' }
            : { status: 'error', message: 'SSH host is offline' };
        },
      },
    } as any;
  }, { theme, initialMode });
  await page.routeWebSocket('**/server-connection', async (socket) => {
    if (await page.evaluate(() => (window as any).__sshTest.mode === 'ready')) {
      socket.send(JSON.stringify({ type: 'ready', serverTime: new Date().toISOString() }));
    }
  });
  await page.goto('/projects');
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
  else await expect(page.locator('html')).not.toHaveClass(/dark/);
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: cancel startup, ignore its late result, then manually reconnect`, async ({ page }) => {
    await prepareRemoteWindow(page, theme, 'hang');
    const connecting = page.getByRole('region', { name: 'Reconnecting to remote server' });
    await expect(connecting).toBeVisible();
    const cancel = page.getByRole('button', { name: 'Cancel reconnection' });
    await cancel.focus();
    await expect(cancel).toBeFocused();
    expect(await cancel.evaluate((button) => getComputedStyle(button).boxShadow)).not.toBe('none');
    await cancel.click();
    const disconnected = page.getByRole('region', { name: 'Remote connection lost' });
    await expect(disconnected).toBeVisible();
    await expect(disconnected).toContainText('Automatic reconnection is paused.');
    await page.evaluate(() => {
      (window as any).__sshTest.finish({ status: 'ready', localPort: 43100 });
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(6500);
    await expect(connecting).toBeHidden();
    await expect(disconnected).toBeVisible();
    expect(await page.evaluate(() => (window as any).__sshTest.calls)).toBe(1);
    expect(await page.evaluate(() => (window as any).__sshTest.canceled)).toBeGreaterThan(0);
    await page.evaluate(() => { (window as any).__sshTest.mode = 'ready'; });
    await page.getByRole('button', { name: 'Reconnect now' }).click();
    await expect(disconnected).toBeHidden();
    await expect(connecting).toBeHidden();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test(`${theme}: expose automatic retry timing and keep pause stable`, async ({ page }) => {
    await prepareRemoteWindow(page, theme, 'error');
    const disconnected = page.getByRole('region', { name: 'Remote connection lost' });
    await expect(disconnected).toBeVisible();
    await expect(disconnected).toContainText('SSH host is offline');
    await expect(disconnected).toContainText('Automatic retry in');
    await page.getByRole('button', { name: 'Pause retries' }).click();
    await expect(disconnected).toContainText('Automatic reconnection is paused.');
    await expect(page.getByRole('button', { name: 'Pause retries' })).toBeHidden();
    await page.waitForTimeout(6500);
    expect(await page.evaluate(() => (window as any).__sshTest.calls)).toBe(1);
    await expect(disconnected).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect now' })).toBeEnabled();
  });
  test(`${theme}: require a password and restore the workspace after submitting it`, async ({ page }) => {
    await prepareRemoteWindow(page, theme, 'password');
    const disconnected = page.getByRole('region', { name: 'Remote connection lost' });
    await expect(disconnected).toBeVisible();
    const reconnect = page.getByRole('button', { name: 'Reconnect now' });
    await expect(reconnect).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Pause retries' })).toBeHidden();
    expect(await page.evaluate(() => (window as any).__sshTest.calls)).toBe(0);
    await page.getByPlaceholder('SSH password', { exact: true }).fill(' secret ');
    await expect(reconnect).toBeEnabled();
    await page.evaluate(() => { (window as any).__sshTest.mode = 'ready'; });
    await reconnect.click();
    await expect(disconnected).toBeHidden();
    expect(await page.evaluate(() => (window as any).__sshTest.password)).toBe(' secret ');
  });

}
