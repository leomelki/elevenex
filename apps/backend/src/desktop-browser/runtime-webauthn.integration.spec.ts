import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWebAuthnExtension } from './runtime-webauthn-extension.js';
import { RuntimeWebAuthn } from './runtime-webauthn.js';
import { z } from 'zod';

jest.setTimeout(60000);
describe('Chromium WebAuthn proxy', () => {
  let root: string, context: BrowserContext, page: Page, relay: RuntimeWebAuthn;
  let visible = true;
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++)
      await new Promise((resolve) => setTimeout(resolve, 30));
    expect(condition()).toBe(true);
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-webauthn-'));
    const extension = await prepareWebAuthnExtension(root);
    context = await chromium.launchPersistentContext(join(root, 'profile'), {
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--load-extension=' + extension,
        '--disable-extensions-except=' + extension,
      ],
    });
    relay = new RuntimeWebAuthn(
      () => undefined,
      (origin) => visible && origin === 'http://login.localhost',
    );
    await relay.configure(true, true);
    await relay.start(context);
    expect(relay.available).toBe(true);
    page = await context.newPage();
    await page.route('http://login.localhost/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Authentication</title>',
      }),
    );
    await page.goto('http://login.localhost/');
    const debuggerSession = await context.newCDPSession(page);
    await debuggerSession.send('Emulation.setFocusEmulationEnabled', {
      enabled: true,
    });
  });
  afterAll(async () => {
    await relay?.destroy();
    await context?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const begin = () =>
    page.evaluate(() => {
      const state = window as typeof window & {
        ceremony?: Promise<string>;
        abort?: AbortController;
      };
      state.abort = new AbortController();
      state.ceremony = navigator.credentials
        .create({
          signal: state.abort.signal,
          publicKey: {
            rp: { id: 'login.localhost', name: 'Example' },
            user: {
              id: new Uint8Array([1]),
              name: 'alice',
              displayName: 'Alice',
            },
            challenge: new Uint8Array([2, 3, 4]),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          },
        })
        .then(
          () => 'success',
          (error: DOMException) => error.name,
        );
    });
  const outcome = () =>
    page.evaluate(
      () => (window as typeof window & { ceremony: Promise<string> }).ceremony,
    );
  it('receives engine-validated origin and options without patching page APIs', async () => {
    expect(
      await page.evaluate(() =>
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      ),
    ).toBe(true);
    await begin();
    await wait(() => !!relay.snapshot());
    const item = relay.snapshot()!;
    expect(item).toEqual({
      id: item.id,
      origin: 'http://login.localhost',
      operation: 'create',
    });
    const options = z
      .object({
        rp: z.object({ id: z.string() }),
        extensions: z.object({
          remoteDesktopClientOverride: z.object({
            origin: z.string(),
            sameOriginWithAncestors: z.boolean(),
          }),
        }),
      })
      .parse(JSON.parse(relay.read(item.id).optionsJson));
    expect(options.rp.id).toBe('login.localhost');
    expect(options.extensions.remoteDesktopClientOverride).toEqual({
      origin: item.origin,
      sameOriginWithAncestors: true,
    });
    await relay.complete(item.id, {
      error: { name: 'NotAllowedError', message: 'Canceled' },
    });
    expect(await outcome()).toBe('NotAllowedError');
    await expect(
      relay.complete(item.id, { responseJson: '{}' }),
    ).rejects.toThrow('expired');
  });
  it('rejects RP spoofing in Chromium before a request reaches the viewer', async () => {
    expect(
      await page.evaluate(async () => {
        try {
          await navigator.credentials.get({
            publicKey: {
              challenge: new Uint8Array([1]),
              rpId: 'attacker.test',
            },
          });
          return 'success';
        } catch (error) {
          return error instanceof DOMException ? error.name : 'unknown';
        }
      }),
    ).toBe('SecurityError');
    expect(relay.snapshot()).toBeUndefined();
  });
  it('cancels the initiating document on navigation', async () => {
    await begin();
    await wait(() => !!relay.snapshot());
    const id = relay.snapshot()!.id;
    await page.goto('http://login.localhost/next');
    await wait(() => !relay.snapshot());
    expect(() => relay.read(id)).toThrow('expired');
  });
  it('fails malformed completion without leaving a native request pending', async () => {
    await begin();
    await wait(() => !!relay.snapshot());
    await relay.complete(relay.snapshot()!.id, { responseJson: '{}' });
    expect(await outcome()).toBe('NotAllowedError');
    expect(relay.snapshot()).toBeUndefined();
  });
  it('invalidates handles on abort, hide and viewer loss without reopening them', async () => {
    await begin();
    await wait(() => !!relay.snapshot());
    const first = relay.snapshot()!.id;
    await page.evaluate(() =>
      (window as typeof window & { abort: AbortController }).abort.abort(),
    );
    expect(await outcome()).toBe('AbortError');
    await wait(() => !relay.snapshot());
    expect(() => relay.read(first)).toThrow('expired');
    await begin();
    await wait(() => !!relay.snapshot());
    visible = false;
    await wait(() => !relay.snapshot());
    expect(await outcome()).toBe('NotAllowedError');
    visible = true;
    await begin();
    await wait(() => !!relay.snapshot());
    await relay.configure(false, false);
    expect(await outcome()).toBe('NotAllowedError');
    expect(
      await page.evaluate(() =>
        PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      ),
    ).toBe(false);
  });
  it('invalidates document handles when their page closes', async () => {
    await relay.configure(true, true);
    await begin();
    await wait(() => !!relay.snapshot());
    const id = relay.snapshot()!.id;
    await page.close();
    await wait(() => !relay.snapshot());
    expect(() => relay.read(id)).toThrow('expired');
  });
});
