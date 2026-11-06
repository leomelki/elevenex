import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserInput } from './runtime-input.js';

jest.setTimeout(90000);
it('uses native Chromium composition, platform-independent editing, key repeat and cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-browser-input-'));
  const previous = process.env['ELEVENEX_DATA_ROOT'];
  process.env['ELEVENEX_DATA_ROOT'] = root;
  const pool = new RuntimeBrowserPool();
  try {
    const context = await pool.acquire('d'.repeat(64), {});
    const page = await context.newPage();
    await page.setContent(
      '<input id="field"><script>window.keys=[];document.addEventListener("keydown",e=>keys.push([e.key,e.repeat]));window.releases=0;document.addEventListener("mouseup",()=>releases++)</script>',
    );
    const cdp = await context.newCDPSession(page);
    const input = new RuntimeBrowserInput(page, cdp);
    const current = () => undefined;
    const value = () => page.locator('#field').inputValue();
    await page.locator('#field').focus();
    await input.dispatch({ kind: 'text', text: 'first' }, current);
    await input.dispatch({ kind: 'edit', operation: 'undo' }, current);
    expect(await value()).toBe('');
    await input.dispatch({ kind: 'edit', operation: 'redo' }, current);
    expect(await value()).toBe('first');
    await input.dispatch(
      { kind: 'clipboard', operation: 'selectAll' },
      current,
    );
    await input.dispatch({ kind: 'text', text: 'second' }, current);
    expect(await value()).toBe('second');
    await input.dispatch(
      { kind: 'clipboard', operation: 'selectAll' },
      current,
    );
    await input.dispatch(
      { kind: 'composition', text: 'に', selectionStart: 1, selectionEnd: 1 },
      current,
    );
    expect(await value()).toBe('に');
    await input.dispatch(
      { kind: 'composition', text: '日本', selectionStart: 2, selectionEnd: 2 },
      current,
    );
    await input.dispatch({ kind: 'text', text: '日本語' }, current);
    expect(await value()).toBe('日本語');
    await input.dispatch(
      {
        kind: 'composition',
        text: 'cancel',
        selectionStart: 6,
        selectionEnd: 6,
      },
      current,
    );
    await input.reset();
    expect(await value()).toBe('日本語');
    const key = {
      kind: 'key' as const,
      type: 'down' as const,
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      modifiers: 8,
    };
    await input.dispatch(key, current);
    await input.dispatch(key, current);
    expect(
      await page.evaluate('window.keys.filter(e=>e[0]==="Shift")'),
    ).toEqual([
      ['Shift', false],
      ['Shift', true],
    ]);
    await input.dispatch(
      {
        kind: 'pointer',
        type: 'down',
        x: 300,
        y: 200,
        button: 'left',
        buttons: 1,
        clicks: 1,
        modifiers: 8,
      },
      current,
    );
    await input.dispatch({ kind: 'release' }, current);
    expect(await page.evaluate('window.releases')).toBe(1);
    await input.dispatch(key, current);
    expect(await page.evaluate('window.keys.at(-1)')).toEqual(['Shift', false]);
    let valid = true;
    const check = () => {
      if (!valid) throw new Error('Control changed');
    };
    const queued = input.dispatch(
      { kind: 'text', text: 'never delivered' },
      check,
    );
    valid = false;
    await expect(queued).rejects.toThrow('Control changed');
    expect(await value()).toBe('日本語');
    await input.reset();
    await page.setContent('<input id="field"><script>document.addEventListener("keydown", e => { if(e.key === "x") e.preventDefault(); })</script>');
    await page.locator('#field').focus();
    await input.dispatch({ kind: 'key', type: 'down', key: 'x', code: 'KeyX', keyCode: 88, modifiers: 0, text: 'x' }, current);
    expect(await value()).toBe('');
    await input.dispatch({ kind: 'key', type: 'up', key: 'x', code: 'KeyX', keyCode: 88, modifiers: 0 }, current);
    await input.dispatch({ kind: 'key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' }, current);
    expect(await value()).toBe('a');
    await input.reset();
    await page.setContent('<iframe srcdoc="<input value=frame-text>"></iframe><div id="shadow"></div>');
    const frame = page.frames()[1]!;
    await frame.locator('input').focus();
    await frame.locator('input').selectText();
    expect(await input.dispatch({ kind: 'clipboard', operation: 'copy' }, current)).toEqual({ clipboard: 'frame-text' });
    expect(await input.dispatch({ kind: 'clipboard', operation: 'cut' }, current)).toEqual({ clipboard: 'frame-text' });
    expect(await frame.locator('input').inputValue()).toBe('');
    await page.evaluate(() => {
      const shadow = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<input value="shadow-text">';
      const field = shadow.querySelector('input')!;
      field.focus(); field.select();
    });
    expect(await input.dispatch({ kind: 'clipboard', operation: 'copy' }, current)).toEqual({ clipboard: 'shadow-text' });
    await page.evaluate(() => {
      const field = document.querySelector('#shadow')!.shadowRoot!.querySelector('input')!;
      field.type = 'password'; field.focus(); field.select();
    });
    expect(await input.dispatch({ kind: 'clipboard', operation: 'copy' }, current)).toEqual({});
  } finally {
    await pool.onModuleDestroy();
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
