import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

jest.setTimeout(90000);
describe('Real Playwright in the task browser', () => {
  let root: string,
    fixture: Server,
    base: string,
    pool: RuntimeBrowserPool,
    task: RuntimeBrowserTask;
  let previous: string | undefined;
  let sensitiveRequests = 0;
  const run = (code: string, timeoutMs = 20000) =>
    task.code(
      2,
      { kind: 'code', code, timeoutMs },
      new AbortController().signal,
    );
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-real-playwright-'));
    previous = process.env['ELEVENEX_DATA_ROOT'];
    process.env['ELEVENEX_DATA_ROOT'] = root;
    fixture = createServer((req, res) => {
      if (req.url === '/sensitive') {
        sensitiveRequests++;
        res.end('real side effect');
        return;
      }
      if (req.url === '/api' || req.url === '/upstream') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ source: 'real-server' }));
        return;
      }
      if (req.url === '/download') {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="notes.txt"',
        );
        res.end('owned-download');
        return;
      }
      if (req.url === '/frame') {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<button onclick="this.textContent=\'Inside done\'">Inside</button><input aria-label="Inner value">',
        );
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><title>Playwright task</title><style>body{font:20px sans-serif;padding:20px}button,input{font:inherit;margin:10px}iframe{display:block;width:500px;height:180px;border:0}</style><h1>Waiting</h1><input aria-label="Name"><button onclick="fetch('/api').then(r=>r.json()).then(r=>document.querySelector('h1').textContent=r.label)">Save</button><a href="/download">Download</a><input aria-label="Upload" type="file"><iframe title="Inner" src="${base.replace('localhost', '127.0.0.1')}/frame"></iframe><script>window.trusted=[];for(const t of ['input','mousedown'])addEventListener(t,e=>trusted.push(e.isTrusted));console.log('site-ready')</script>`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    base = 'http://localhost:' + address.port;
    pool = new RuntimeBrowserPool();
    task = new RuntimeBrowserTask(1, pool, 'd'.repeat(64), (session) =>
      session === 2
        ? Promise.resolve()
        : Promise.reject(new Error('Wrong conversation')),
    );
  });
  afterAll(async () => {
    await task?.destroy();
    await pool?.onModuleDestroy();
    fixture?.closeAllConnections();
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(root, { recursive: true, force: true });
  });
  it('acquires a user tab in one call, respects Stop through reset and resumes only after handoff', async () => {
    const opened = await task.command({ kind: 'open', url: base });
    const id = opened.active!;
    const acquired = await run(`
      state.userPage=await browser.page(${JSON.stringify(id)});
      await state.userPage.getByLabel('Name',{exact:true}).fill('Acquired');
      await state.userPage.getByRole('button',{name:'Save',exact:true}).click();
      return await state.userPage.evaluate(()=>trusted);
    `);
    expect(acquired.error).toBeUndefined();
    expect(acquired.value).toEqual([true, true]);
    expect(task.tabs.get(id)!.driver).toBe('agent');
    const foreign = await task.code(3, { kind: 'code', code: `await browser.page(${JSON.stringify(id)})`, timeoutMs: 15000 }, new AbortController().signal);
    expect(foreign.error?.message).toContain('another conversation');

    await task.command({ kind: 'takeover', tabId: id });
    expect((await run('return await state.userPage.title()')).error).toBeDefined();
    expect((await run(`await browser.page(${JSON.stringify(id)})`)).error?.message).toContain('stopped');
    expect((await run(`await browser.tabs.get(${JSON.stringify(id)})`)).error?.message).toContain('stopped');
    await task.code(2, { kind: 'code', code: '', reset: true, timeoutMs: 15000 }, new AbortController().signal);
    expect((await run(`await browser.page(${JSON.stringify(id)})`)).error?.message).toContain('stopped');
    await task.command({ kind: 'handoff', tabId: id, sessionId: 2 });
    const resumed = await run(`state.userPage=await browser.page(${JSON.stringify(id)});return await state.userPage.getByLabel('Name',{exact:true}).inputValue()`);
    expect(resumed.error).toBeUndefined();
    expect(resumed.value).toBe('Acquired');
    expect((await run(`const tab=await browser.tabs.get(${JSON.stringify(id)});await tab.close()`)).error?.message).toContain('User-created');
    // UI-only ownership changes allow fresh acquisition without replaying old work.
    task.tabs.get(id)!.takeover(false, false);
    expect((await run(`state.userTab=await browser.tabs.get(${JSON.stringify(id)});return await state.userTab.evaluate(()=>document.title)`)).value).toBe('Playwright task');
    await task.command({ kind: 'close', tabId: id });
  });
  it('publishes steps and cursor feedback live within one call, then rejects stale/stopped feedback', async () => {
    const updates: { status?: string; cursor?: { x: number; y: number; pulse: number }; highlight?: { width: number } }[] = [];
    const stop = task.subscribe(() => {
      const tab = task.state().tabs.at(-1);
      if (tab?.step?.text.startsWith('Feedback')) updates.push({ status: tab.step.status, cursor: tab.agentCursor, highlight: tab.agentHighlight });
    });
    try {
      const result = await run(`
        state.feedbackPage=await context.newPage();
        await state.feedbackPage.goto(${JSON.stringify(base)});
        await browser.step(state.feedbackPage,{n:1,total:3,text:'Feedback: locate Save',status:'running'});
        const save=state.feedbackPage.getByRole('button',{name:'Save',exact:true});
        await browser.cursor.move(state.feedbackPage,save,{highlight:true,label:'Save changes'});
        await browser.step(state.feedbackPage,{n:2,total:3,text:'Feedback: waiting for result',status:'waiting'});
        await state.feedbackPage.route('**/api',route=>route.fulfill({json:{label:'Feedback verified'}}));
        await save.click();
        await expect(state.feedbackPage.getByRole('heading')).toHaveText('Feedback verified');
        await browser.step(state.feedbackPage,{n:3,total:3,text:'Feedback verified',status:'done'});
        return await state.feedbackPage.evaluate(()=>document.querySelector('.agent-cursor')===null);
      `);
      expect(result.error).toBeUndefined(); expect(result.value).toBe(true);
      expect(updates.some(update => update.status === 'running' && update.cursor && update.highlight && update.highlight.width > 0)).toBe(true);
      expect(updates.some(update => update.status === 'waiting' && (update.cursor?.pulse ?? 0) > 0)).toBe(true);
      expect(updates.at(-1)).toEqual({ status: 'done', cursor: undefined, highlight: undefined });
      const tab = [...task.tabs.values()].at(-1)!;
      expect((await run('await browser.cursor.move(state.feedbackPage,{x:Infinity,y:20})')).error).toBeDefined();
      await run('await browser.cursor.move(state.feedbackPage,{x:40,y:50},{pulse:true});await browser.cursor.hide(state.feedbackPage)');
      expect(tab.snapshot().agentCursor).toBeUndefined();
      const target = await tab.agentTarget(2, () => true, () => Promise.resolve(), () => Promise.resolve());
      const documentId = tab.documentId;
      const generation = tab.generation;
      const viewport = await run('return await state.feedbackPage.evaluate(()=>({width:innerWidth,height:innerHeight}))');
      const size = viewport.value as { width: number; height: number };
      await tab.layout(size.width, size.height + 20, true, false);
      await target.present!({ kind: 'cursor', point: { x: 20, y: 20 } }, documentId, generation);
      expect(tab.snapshot().agentCursor).toBeUndefined();
      await tab.navigate(base + '?next-document');
      await expect(Promise.resolve().then(() => target.present!({ kind: 'cursor', point: { x: 20, y: 20 } }, documentId))).rejects.toThrow('document changed');
      await target.dispose?.();
      await task.command({ kind: 'takeover', tabId: tab.id });
      expect((await run("await browser.step(state.feedbackPage,{n:1,text:'Late',status:'running'})")).error).toBeDefined();
      expect(tab.snapshot().agentCursor).toBeUndefined();
      await task.command({ kind: 'close', tabId: tab.id });
    } finally { stop(); }
  });
  it('uses actual locators, callback closures, assertions, frames and PNGs', async () => {
    const result = await run(`
      state.page=await context.newPage(); state.console=[];
      state.page.on('console',message=>state.console.push(message.text()));
      const label='Mocked through closure';
      await state.page.route('**/api',async route=>{await route.fulfill({json:{label}})});
      await state.page.goto(${JSON.stringify(base)});
      await state.page.getByRole('textbox',{name:'Name',exact:true}).fill('Ada');
      await state.page.getByRole('button',{name:'Save',exact:true}).click();
      await expect(state.page.getByRole('heading')).toHaveText(label);
      await state.page.frameLocator('iframe').getByRole('button',{name:'Inside',exact:true}).click();
      await expect(state.page.frameLocator('iframe').getByRole('button')).toHaveText('Inside done');
      await emitImage(await state.page.screenshot({fullPage:true}));
      return {trusted:await state.page.evaluate(()=>trusted),console:state.console,url:state.page.url()};
    `);
    expect(result.error).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mimeType).toBe('image/png');
    const data = result.value as {
      trusted: boolean[];
      console: string[];
      url: string;
    };
    expect(data.trusted.every(Boolean)).toBe(true);
    expect(data.console).toContain('site-ready');
    expect(data.url).toBe(base + '/');
    const directory = resolve(
      __dirname,
      '../../../../artifacts/browser-playwright',
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'chromium.png'),
      Buffer.from(result.images[0]!.data, 'base64'),
    );
  });
  it('keeps routes and closures between calls, handles concurrent waits, and fetches through the task proxy', async () => {
    const result = await run(`
      await state.page.route('**/upstream',async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),modified:true}})});
      const [response]=await Promise.all([state.page.waitForResponse(r=>r.url().endsWith('/api')),state.page.getByRole('button',{name:'Save',exact:true}).click()]);
      const upstream=await state.page.evaluate(async()=>await(await fetch('/upstream')).json());
      return {status:response.status(),upstream,stillMocked:await state.page.getByRole('heading').innerText()};
    `);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      status: 200,
      upstream: { source: 'real-server', modified: true },
      stillMocked: 'Mocked through closure',
    });
  });
  it('supports binary uploads and browser-owned downloads in confined artifacts', async () => {
    const result = await run(`
      await state.page.getByLabel('Upload',{exact:true}).setInputFiles({name:'hello.txt',mimeType:'text/plain',buffer:Buffer.from('hello-upload')});
      const uploaded=await state.page.getByLabel('Upload',{exact:true}).evaluate(async el=>await el.files[0].text());
      const [download]=await Promise.all([state.page.waitForEvent('download'),state.page.getByRole('link',{name:'Download'}).click()]);
      await download.saveAs('downloads/notes.txt');
      const bytes=await artifacts.read('downloads/notes.txt');
      return {uploaded,downloaded:bytes.toString('utf8'),name:download.suggestedFilename()};
    `);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      uploaded: 'hello-upload',
      downloaded: 'owned-download',
      name: 'notes.txt',
    });
  });
  it('awaits URL predicates, honors matching-only route counts, and unregisters the original callback', async () => {
    const result = await run(`
      let count=0; const match=url=>url.pathname==='/predicate';
      const handler=route=>{count++;return route.fulfill({json:{mocked:true}})};
      await state.page.route(match,handler,{times:1});
      const one=await state.page.evaluate(async()=>await(await fetch('/predicate')).json());
      await state.page.route(match,handler);
      await state.page.unroute(match,handler);
      await state.page.evaluate(async()=>await fetch('/predicate'));
      return {one,count};
    `);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ one: { mocked: true }, count: 1 });
  });
  it('supports offline WebSocket mocks with closure callbacks and ordered listener registration', async () => {
    const result = await run(`
      const prefix='mock:';
      await state.page.routeWebSocket('**/offline-socket',ws=>{
        ws.onMessage(message=>ws.send(prefix+message));
      });
      await state.page.reload();
      return await state.page.evaluate(()=>new Promise((resolve,reject)=>{
        const socket=new WebSocket(location.origin.replace('http','ws')+'/offline-socket');
        socket.onopen=()=>socket.send('hello');socket.onerror=()=>reject(new Error('socket failed'));
        socket.onmessage=event=>{resolve(event.data);socket.close()};
      }));
    `);
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('mock:hello');
  });
  it('confines artifact-path uploads and PDF streams to their owner', async () => {
    const result = await run(`
      await artifacts.write('upload/file.txt','artifact-upload');
      await state.page.getByLabel('Upload',{exact:true}).setInputFiles('upload/file.txt');
      const text=await state.page.getByLabel('Upload',{exact:true}).evaluate(async element=>await element.files[0].text());
      const pdf=await state.page.pdf({path:'page.pdf'});
      return {text,header:(await readBytes(pdf,0,4)).toString()};
    `);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ text: 'artifact-upload', header: '%PDF' });
  });
  it('isolates sessions and rejects root protocol and host-file capabilities', async () => {
    const other = await task.code(
      3,
      { kind: 'code', code: 'return context.pages().length', timeoutMs: 5000 },
      new AbortController().signal,
    );
    expect(other.error).toBeUndefined();
    expect(other.value).toBe(0);
    const result = await run(`
      const cdp=await context.newCDPSession(state.page);const errors=[];
      for(const [method,params] of [['Target.getTargets',{}],['Browser.close',{}],['IO.read',{handle:'/etc/passwd'}],['DOM.setFileInputFiles',{files:['/etc/passwd']}]] ){
        try{await cdp.send(method,params);errors.push('allowed')}catch(error){errors.push(error.message)}
      }
      await cdp.detach();return errors;
    `);
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveLength(4);
    expect(result.value).not.toContain('allowed');
  });
  it('aborts a paused mocked mutation before timeout detaches the protocol session', async () => {
    const timeout = await run(
      `
      await state.page.route('**/sensitive',()=>new Promise(()=>{}));
      await state.page.evaluate(async()=>{try{await fetch('/sensitive',{method:'POST'})}catch{}});
    `,
      700,
    );
    expect(timeout.error?.outcomeUnknown).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sensitiveRequests).toBe(0);
    const restored = await run(
      'state.page=context.pages()[0];return await state.page.title()',
    );
    expect(restored.error).toBeUndefined();
  });
  it('can terminate a stuck Playwright regular expression without freezing the host', async () => {
    const started = Date.now();
    const timeout = await run(
      `await expect('a'.repeat(45)+'!').toMatch(/(a+)+$/)`,
      400,
    );
    expect(timeout.error?.outcomeUnknown).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    const restored = await run(
      'state.page=context.pages()[0];return await state.page.title()',
    );
    expect(restored.error).toBeUndefined();
  });
  it('dismisses a dialog whose agent callback is interrupted, so the real tab stays usable', async () => {
    const interrupted = await run(
      `state.page.on('dialog',()=>new Promise(()=>{}));await state.page.evaluate(()=>prompt('Interrupted agent prompt'))`,
      700,
    );
    expect(interrupted.error?.outcomeUnknown).toBe(true);
    const restored = await run(
      `state.page=context.pages()[0];return await state.page.getByRole('heading').innerText()`,
    );
    expect(restored.error).toBeUndefined();
    expect(restored.value).toBeTruthy();
  });
  it('revokes opener-linked popups together, keeps unrelated pages independent, and returns the group to the ticket creator', async () => {
    const opened = await run(`
      const [popup]=await Promise.all([state.page.waitForEvent('popup'),state.page.evaluate(()=>{window.open('/frame')})]);
      state.popup=popup;await popup.waitForLoadState();state.independent=await context.newPage();
      return (await browser.tabs.list()).map(tab=>({id:tab.id,url:tab.url}));
    `);
    expect(opened.error).toBeUndefined();
    const popupId = (opened.value as { id: string; url?: string }[]).find(
      (tab) => tab.url?.endsWith('/frame'),
    )!.id;
    const created = await run(
      `return await human.requestAction(state.page,{message:'Do the manual step with its related popup'})`,
    );
    expect(created.error).toBeUndefined();
    const ticket = created.value as { id: string; tabId: string };
    expect(task.tabs.get(ticket.tabId)?.driver).toBe('needs');
    expect(task.tabs.get(popupId)?.driver).toBe('needs');
    const blocked = await run(
      `try{await state.popup.evaluate(()=>window.opener.document.body.innerText);return 'leaked'}catch{return await state.independent.title()}`,
    );
    expect(blocked.error).toBeUndefined();
    expect(blocked.value).toBe('');
    await task.command({ kind: 'handoff', tabId: popupId, sessionId: 99 });
    expect(task.userRequest(ticket.id).status).toBe('completed');
    expect(task.tabs.get(popupId)?.agentSessionId).toBe(2);
    expect(task.tabs.get(ticket.tabId)?.agentSessionId).toBe(2);
    const cleanup = await run(
      `await (await browser.page(${JSON.stringify(popupId)})).close();await state.independent.close();state.page=await browser.page(${JSON.stringify(ticket.tabId)});return await state.page.title()`,
    );
    expect(cleanup.error).toBeUndefined();
    expect(cleanup.value).toBe('Playwright task');
  });
  it('rejects private/root/file escapes and cancels Playwright retries without closing the real tab', async () => {
    const cyclic = await run(
      'await state.page.evaluate(()=>{const value={};value.self=value;return value})',
    );
    expect(cyclic.error?.message).toContain('cyclic');
    const denied = await run(
      `try{await state.page.screenshot({path:'/private/host-secret.png'})}catch(error){return error.message}`,
    );
    expect(denied.value).toEqual(expect.stringContaining('artifact'));
    const fields = await run(
      `return [typeof process,typeof require,typeof globalThis.__elevenexData,state.page.constructor,context.constructor]`,
    );
    expect(fields.value).toEqual([
      'undefined',
      'undefined',
      'undefined',
      null,
      null,
    ]);
    const timeout = await run(
      `await state.page.getByRole('button',{name:'Will never exist'}).click()`,
      400,
    );
    expect(timeout.error?.outcomeUnknown).toBe(true);
    const fresh = await run(
      `state.page=context.pages()[0];return await state.page.title()`,
    );
    expect(fresh.error).toBeUndefined();
    expect(fresh.value).toBe('Playwright task');
  });
  it('creates a human ticket, survives reset, confirms a picked input, and returns to its creator', async () => {
    const created = await run(
      `return await human.requestElement(state.page,{message:'Choose the Name field'})`,
    );
    expect(created.error).toBeUndefined();
    const ticket = created.value as {
      id: string;
      tabId: string;
      sessionId: number;
    };
    expect(ticket.sessionId).toBe(2);
    expect(task.userRequest(ticket.id).status).toBe('pending');
    expect(
      [...task.tabs.values()].find((tab) => tab.id === ticket.tabId)?.driver,
    ).toBe('needs');
    await task.code(
      2,
      { kind: 'code', code: '', timeoutMs: 1000, reset: true },
      new AbortController().signal,
    );
    const pending = await run(
      `return await human.result(${JSON.stringify(ticket.id)})`,
    );
    expect(pending.error).toBeUndefined();
    expect((pending.value as { status: string }).status).toBe('pending');
    await task.command({ kind: 'agent-request-pick', visual: 1, requestId: ticket.id });
    const tab = task.tabs.get(ticket.tabId)!;
    const trustedTarget = await tab.agentTarget(
      1,
      () => true,
      () => Promise.resolve(),
      () => Promise.resolve(),
      undefined,
      undefined,
      () => true,
    );
    const reply = await trustedTarget.send('Runtime.evaluate', {
      expression: `(()=>{const r=document.querySelector('input').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      returnByValue: true,
    });
    await trustedTarget.dispose?.();
    const point = (reply as { result: { value: { x: number; y: number } } })
      .result.value;
    await tab.agentPicker!(point.x, point.y);
    expect(task.userRequest(ticket.id).selection?.tag).toBe('input');
    const snapshot = task.userRequest(ticket.id).selection?.snapshot;
    expect(snapshot?.jpeg).toBeTruthy();
    expect(Buffer.from(snapshot!.jpeg!, 'base64').readUInt16BE(0)).toBe(0xffd8);
    expect(snapshot!.reference.image.scale).toBe(1);
    expect(snapshot!.reference.crop.width).toBeLessThanOrEqual(1600);
    expect(tab.driver).toBe('needs');
    await task.command({
      kind: 'agent-request-complete',
      requestId: ticket.id,
    });
    expect(tab.driver).toBe('agent');
    expect(tab.agentSessionId).toBe(2);
    const use = await run(
      `const selected=await human.locator(${JSON.stringify(ticket.id)});await selected.fill('Human chose this');return await selected.inputValue()`,
    );
    expect(use.error).toBeUndefined();
    expect(use.value).toBe('Human chose this');
  });
  it('returns action requests to their creator and invalidates a confirmed iframe selection after navigation', async () => {
    const action = await run(
      `state.page=await browser.page((await browser.tabs.list()).find(tab=>tab.owned).id);return await human.requestAction(state.page,{message:'Complete the manual step'})`,
    );
    expect(action.error).toBeUndefined();
    const ticket = action.value as { id: string; tabId: string };
    await task.command({
      kind: 'agent-request-complete',
      requestId: ticket.id,
    });
    const reacquired = await run(
      `state.page=await browser.page(${JSON.stringify(ticket.tabId)});return await state.page.title()`,
    );
    expect(reacquired.error).toBeUndefined();
    expect(reacquired.value).toBe('Playwright task');
    const created = await run(
      `return await human.requestElement(state.page,{message:'Choose the button inside the frame'})`,
    );
    const picked = created.value as { id: string; tabId: string };
    await task.command({ kind: 'agent-request-pick', visual: 1, requestId: picked.id });
    const tab = task.tabs.get(picked.tabId)!;
    const inspect = await tab.agentTarget(
      1,
      () => true,
      () => Promise.resolve(),
      () => Promise.resolve(),
      undefined,
      undefined,
      () => true,
    );
    const reply = await inspect.send('Runtime.evaluate', {
      expression: `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.x+80,y:r.y+20}})()`,
      returnByValue: true,
    });
    await inspect.dispose?.();
    const point = (reply as { result: { value: { x: number; y: number } } })
      .result.value;
    await tab.agentPicker!(point.x, point.y);
    expect(task.userRequest(picked.id).selection?.frames).toHaveLength(1);
    await task.command({
      kind: 'agent-request-complete',
      requestId: picked.id,
    });
    const stale = await run(
      `state.page=await browser.page(${JSON.stringify(picked.tabId)});await state.page.frameLocator('iframe').locator('body').evaluate(()=>{location.href='/frame?new-document'});await expect.poll(()=>state.page.frameLocator('iframe').locator('body').evaluate(()=>location.search)).toBe('?new-document');try{await human.locator(${JSON.stringify(picked.id)})}catch(error){return error.message}`,
    );
    expect(stale.error).toBeUndefined();
    expect(stale.value).toContain('navigated');
  });
});
