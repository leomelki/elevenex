import {
  BrowserInteractions,
  NestedSessions,
  ProtocolLease,
  BrowserAgentEngine,
} from '@elevenex/browser-agent';

describe('Browser protocol lease cleanup', () => {
  it('dismisses an intercepted agent dialog and restores file chooser handling before detachment', async () => {
    const calls: unknown[][] = [];
    const lease = new ProtocolLease(
      async (...args) => {
        calls.push(args);
        return {};
      },
      async () => {
        calls.push(['detach']);
      },
    );
    await lease.send('Page.setInterceptFileChooserDialog', { enabled: true });
    lease.receive('Page.javascriptDialogOpening', { type: 'prompt' });
    await lease.dispose();
    expect(calls.slice(1)).toEqual([
      ['Page.handleJavaScriptDialog', { accept: false }, undefined],
      ['Page.setInterceptFileChooserDialog', { enabled: false }, undefined],
      ['detach'],
    ]);
  });
  it('aborts paused HTTP/authentication before detach after listeners unsubscribe', async () => {
    const calls: unknown[][] = [];
    const lease = new ProtocolLease(
      async (...args) => {
        calls.push(args);
        return {};
      },
      async () => {
        calls.push(['detach']);
      },
    );
    const listener = jest.fn();
    const unsubscribe = lease.subscribe(listener);
    unsubscribe();
    lease.receive('Fetch.requestPaused', { requestId: 'post' }, 'frame');
    lease.receive('Fetch.authRequired', { requestId: 'auth' });
    await lease.dispose();
    await lease.dispose();
    expect(listener).not.toHaveBeenCalled();
    expect(calls).toEqual([
      [
        'Fetch.failRequest',
        { requestId: 'post', errorReason: 'Aborted' },
        'frame',
      ],
      [
        'Fetch.continueWithAuth',
        {
          requestId: 'auth',
          authChallengeResponse: { response: 'CancelAuth' },
        },
        undefined,
      ],
      ['detach'],
    ]);
    await expect(lease.send('Page.navigate', {})).rejects.toThrow('closed');
  });
  it('preserves a new pause with the same request ID while an earlier continuation resolves', async () => {
    const calls: string[] = [];
    let lease: ProtocolLease;
    lease = new ProtocolLease(
      async (method) => {
        calls.push(method);
        if (method === 'Fetch.continueRequest')
          lease.receive('Fetch.requestPaused', { requestId: 'redirect' });
        return {};
      },
      async () => {
        calls.push('detach');
      },
    );
    lease.receive('Fetch.requestPaused', { requestId: 'redirect' });
    await lease.send('Fetch.continueRequest', { requestId: 'redirect' });
    await lease.dispose();
    expect(calls).toEqual([
      'Fetch.continueRequest',
      'Fetch.failRequest',
      'detach',
    ]);
  });
  it('terminates in-flight evaluations in their specific child session', async () => {
    const calls: unknown[][] = [];
    let finish: (() => void) | undefined;
    const lease = new ProtocolLease(
      async (...args) => {
        calls.push(args);
        if (args[0] === 'Runtime.evaluate')
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return {};
      },
      async () => undefined,
    );
    const evaluation = lease.send('Runtime.evaluate', {}, 'child');
    await lease.dispose();
    finish!();
    await evaluation;
    expect(calls).toContainEqual(['Runtime.terminateExecution', {}, 'child']);
  });
  it('rejects foreign nested sessions and clears pending commands on child detachment', async () => {
    const send = jest.fn().mockResolvedValue({});
    const nested = new NestedSessions(send);
    await expect(nested.send('Runtime.enable', {}, 'foreign')).rejects.toThrow(
      'outside',
    );
    expect(send).not.toHaveBeenCalled();
    nested.receive(
      'Target.attachedToTarget',
      { sessionId: 'child' },
      () => undefined,
    );
    const command = nested.send('Runtime.enable', {}, 'child');
    nested.receive(
      'Target.detachedFromTarget',
      { sessionId: 'child' },
      () => undefined,
    );
    await expect(command).rejects.toThrow('detached');
    nested.dispose();
    await expect(nested.send('Runtime.enable', {})).rejects.toThrow('outside');
  });
});

describe('Human request lifetime', () => {
  it('bounds pending requests and withholds cross-conversation results', () => {
    const store = new BrowserInteractions(() => undefined);
    const ticket = store.create(2, 'tab', 'element', 'Choose a control');
    expect(() => store.get(ticket.id, 3)).toThrow('unavailable');
    expect(() => store.complete(ticket.id)).toThrow('Select');
    expect(() => store.create(2, 'tab', 'action', 'Again')).toThrow('already');
    for (let i = 0; i < 3; i++)
      store.create(2, 'other-' + i, 'action', 'Continue');
    expect(() => store.create(2, 'overflow', 'action', 'Continue')).toThrow(
      'capacity',
    );
    store.cancelPage('tab');
    expect(store.get(ticket.id, 2).status).toBe('cancelled');
    store.dispose();
  });
});

describe('Code realm data utilities', () => {
  it('provides URL, binary payloads and timers without Node or host function objects', async () => {
    const engine = new BrowserAgentEngine({
      list: () => [],
      get: () => Promise.reject(new Error('No pages')),
      open: () => Promise.reject(new Error('No pages')),
    });
    try {
      const result = await engine.execute(
        1,
        {
          kind: 'code',
          timeoutMs: 2000,
          code: `
        const url=new URL('/path?name=Ada','https://example.test');
        await new Promise(resolve=>setTimeout(resolve,10));
        return [url.hostname,url.searchParams.get('name'),Buffer.from('hello').toString('base64'),typeof process,typeof require,typeof globalThis.__elevenexData];
      `,
        },
        new AbortController().signal,
      );
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual([
        'example.test',
        'Ada',
        'aGVsbG8=',
        'undefined',
        'undefined',
        'undefined',
      ]);
    } finally {
      engine.dispose();
    }
  });
});
