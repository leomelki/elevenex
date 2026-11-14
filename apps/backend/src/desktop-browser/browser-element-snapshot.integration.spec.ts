import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { createServer } from 'node:http';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

jest.setTimeout(60000);
it('captures real runtime pixels before pause, with frame identity and native MCP image delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'element-snapshot-'));
  const previous = process.env['ELEVENEX_DATA_ROOT']; process.env['ELEVENEX_DATA_ROOT'] = root;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url?.startsWith('/frame') ? '<button style="margin:12px;width:120px;height:40px">Save changes</button>' : '<style>body{margin:20px;font:16px system-ui}iframe{width:400px;height:200px}</style><h1>Checkout</h1><iframe src="/frame"></iframe>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const pool = new RuntimeBrowserPool();
  const task = new RuntimeBrowserTask(1, pool, 'e'.repeat(64), () => Promise.resolve());
  try {
    const code = (source: string) => task.code(2, { kind: 'code', code: source, timeoutMs: 20000 }, new AbortController().signal);
    const started = await code(`state.page=await context.newPage();await state.page.goto('http://localhost:${address.port}');state.box=await state.page.frameLocator('iframe').getByRole('button').boundingBox();return {ticket:await human.requestElement(state.page,{message:'Choose Save'}),box:state.box}`);
    expect(started.error).toBeUndefined();
    const value: unknown = started.value;
    if (!value || typeof value !== 'object' || !('ticket' in value) || !('box' in value)) throw new Error('Missing fixture ticket');
    const ticket = value.ticket as { id: string; tabId: string }, box = value.box as { x: number; y: number; width: number; height: number };
    await task.command({ kind: 'agent-request-pick', visual: 1, requestId: ticket.id });
    const tab = task.tabs.get(ticket.tabId)!;
    await tab.agentPicker!(box.x + box.width / 2, box.y + box.height / 2);
    const selection = task.userRequest(ticket.id).selection!;
    expect(selection.frames).toHaveLength(1);
    expect(selection.snapshot?.reference.label).toBe('button · Save changes');
    expect(selection.snapshot?.jpeg).toBeTruthy();
    expect(selection.snapshot?.reference.target).toEqual(box);
    expect(selection.snapshot?.reference.page).not.toContain('?');
    await task.command({ kind: 'agent-request-complete', requestId: ticket.id });
    const delivered = await code(`return await human.result('${ticket.id}')`);
    expect(delivered.images).toHaveLength(1);
    expect(JSON.stringify(delivered.value)).not.toContain(selection.snapshot!.jpeg);
    expect(delivered.images[0]?.data).toBe(selection.snapshot!.jpeg);
    const navigated = await code(`state.page=await browser.page('${ticket.tabId}');await state.page.goto('http://localhost:${address.port}/?changed');return 'navigated'`);
    expect(navigated.error).toBeUndefined();
    const historical = await code(`return await human.result('${ticket.id}')`);
    expect(historical.error).toBeUndefined();
    expect(historical.images[0]?.data).toBe(selection.snapshot!.jpeg);
    const stale = await code(`try{await human.locator('${ticket.id}');return 'unexpected'}catch(error){return error.message}`);
    expect(stale.value).toContain('document changed');
    const directory = resolve(__dirname, '../../../../artifacts/element-mentions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'runtime-snapshot.json'), JSON.stringify(selection.snapshot));
    await writeFile(join(directory, 'runtime-crop.jpg'), Buffer.from(selection.snapshot!.jpeg!, 'base64'));
  } finally {
    await task.destroy(); await pool.onModuleDestroy();
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT']; else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
