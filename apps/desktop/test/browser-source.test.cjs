const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createContext, runInContext } = require('node:vm');
const { TextDecoder } = require('node:util');
const { Response } = globalThis;
const { detectBrowserSource, browserSourceLocation, mappedSource, sourceResourceExpression } = require('@elevenex/browser-inspection');

const selector = 'html > body:nth-child(1) > button:nth-child(1)';
const origin = 'http://localhost:3000';
const map = { version: 3, sources: ['src/Checkout.tsx'], names: [], mappings: 'AAAA;AACA' };
function page(metadata, resources = {}) {
  const calls = [];
  const context = createContext({ URL, TextDecoder, AbortController, setTimeout, clearTimeout, location: { origin },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(resources[url] ?? '', { status: url in resources ? 200 : 404 }); }, Response,
  });
  runInContext(`const node = {closest: () => null, parentElement: null};
    node['__reactFiber$test'] = ${metadata};
    globalThis.document = {querySelector: () => node};`, context);
  return { context, calls, evaluate: async expression => runInContext(expression, context) };
}

test('reads the closest React 18 source without invoking components or props', async () => {
  const fixture = page(`{_debugSource:{fileName:'/workspace/src/Checkout.tsx',lineNumber:88,columnNumber:7},
    get memoizedProps(){throw new Error('Do not read props')}, type:()=>{throw new Error('Do not call components')}}`);
  assert.deepEqual(await detectBrowserSource(fixture.evaluate, selector, origin, () => true), {
    file: '/workspace/src/Checkout.tsx', line: 88, column: 7, kind: 'react-debug-source',
  });
  assert.equal(fixture.calls.length, 0);
});

test('walks owner metadata with cycles bounded and ignores accessors', async () => {
  const fixture = page(`(()=>{const owner={_debugSource:{fileName:'src/Owner.tsx',lineNumber:3}};
    const fiber={get _debugSource(){throw new Error('accessor')},_debugOwner:owner};owner.return=fiber;return fiber})()`);
  assert.equal((await detectBrowserSource(fixture.evaluate, selector, origin, () => true)).file, 'src/Owner.tsx');
  const cycle = page(`(()=>{const f={};f.return=f;return f})()`);
  assert.equal(await detectBrowserSource(cycle.evaluate, selector, origin, () => true), undefined);
});

test('normalizes file URLs, spaces and Windows development paths without retaining URLs', async () => {
  for (const [fileName, expected] of [['file:///work/My%20Project/src/App.tsx', '/work/My Project/src/App.tsx'], ['C:\\work\\src\\App.tsx', 'C:/work/src/App.tsx']]) {
    const fixture = page(`{_debugSource:{fileName:${JSON.stringify(fileName)},lineNumber:1}}`);
    assert.equal((await detectBrowserSource(fixture.evaluate, selector, origin, () => true)).file, expected);
  }
});

for (const inline of [false, true]) test(`resolves React 19 ${inline ? 'inline' : 'external'} maps and keeps HMR identity`, async () => {
  const reference = inline ? 'data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64') : './Checkout.tsx.map?t=2';
  const fixture = page(String.raw`{_debugStack:Object.assign(new Error(),{stack:'Error\n    at jsxDEV (${origin}/node_modules/react/jsx-dev-runtime.js:1:1)\n    at Checkout (${origin}/src/Checkout.tsx?t=2:2:1)'})}`, {
    [origin + '/src/Checkout.tsx?t=2']: 'compiled\n//# sourceMappingURL=' + reference,
    [origin + '/src/Checkout.tsx.map?t=2']: JSON.stringify(map),
  });
  assert.deepEqual(await detectBrowserSource(fixture.evaluate, selector, origin, () => true), { file: 'src/Checkout.tsx', line: 2, column: 1, kind: 'react-source-map' });
  assert.ok(fixture.calls.every(call => call.options.redirect === 'error' && call.options.credentials === 'omit'));
  assert.equal(fixture.calls.length, inline ? 1 : 2);
});

test('honors sourceRoot, indexed offsets and zero/one-based positions', () => {
  assert.deepEqual(mappedSource({ ...map, sourceRoot: 'webpack://shop/./' }, 2, 1, origin), { file: 'src/Checkout.tsx', line: 2, column: 1, kind: 'react-source-map' });
  assert.deepEqual(mappedSource({ version: 3, sections: [{ offset: { line: 4, column: 8 }, map }] }, 5, 9, origin), { file: 'src/Checkout.tsx', line: 1, column: 1, kind: 'react-source-map' });
  assert.equal(mappedSource({ version: 3, sections: [{ offset: { line: 4, column: 8 }, map }] }, 5, 8, origin), undefined);
  assert.equal(mappedSource(map, 10, 1, origin), undefined, 'Do not carry a mapping across an unmapped generated line');
});

test('missing maps never report generated TSX coordinates as source coordinates', async () => {
  const fixture = page(String.raw`{_debugStack:Object.assign(new Error(),{stack:'Error\n at Checkout (${origin}/src/Checkout.tsx:88:7)'})}`, { [origin + '/src/Checkout.tsx']: 'compiled' });
  assert.equal(await detectBrowserSource(fixture.evaluate, selector, origin, () => true), undefined);
});

test('does not fetch cross-origin scripts/maps or filesystem URLs', async () => {
  for (const url of ['https://evil.example/App.tsx', 'file:///secret/App.tsx', 'http://user:secret@localhost:3000/App.tsx']) {
    const fixture = page(String.raw`{_debugStack:Object.assign(new Error(),{stack:'Error\n at App (${url}:1:1)'})}`);
    assert.equal(await detectBrowserSource(fixture.evaluate, selector, origin, () => true), undefined);
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = page(String.raw`{_debugStack:Object.assign(new Error(),{stack:'Error\n at App (${origin}/App.js:1:1)'})}`, { [origin + '/App.js']: '//# sourceMappingURL=https://evil.example/app.map' });
  assert.equal(await detectBrowserSource(fixture.evaluate, selector, origin, () => true), undefined);
  assert.equal(fixture.calls.length, 1);
});

test('remote metadata is bounded, canonical, content-free and never grants file access', () => {
  const valid = { file: 'src/App.tsx', line: 5, kind: 'react-debug-source' };
  assert.deepEqual(browserSourceLocation({ ...valid, props: 'secret', content: 'secret' }), valid);
  for (const field of [{ file: '../secret.tsx' }, { file: 'src/App.tsx?token=secret' }, { file: 'secret\n.tsx' }, { file: 'src/%0aApp.tsx' }, { file: 'node_modules/lib.tsx' }, { file: 'a'.repeat(2048) + '.tsx' }, { line: NaN }, { line: 0 }, { line: 1.5 }, { column: -1 }, { kind: 'guessed' }]) {
    assert.equal(browserSourceLocation({ ...valid, ...field }), undefined);
  }
});

test('navigation/cancellation stops follow-up resources and discards resolved metadata', async () => {
  let current = true;
  const fixture = page(String.raw`{_debugStack:Object.assign(new Error(),{stack:'Error\n at App (${origin}/App.js:1:1)'})}`, { [origin + '/App.js']: '//# sourceMappingURL=app.map', [origin + '/app.map']: JSON.stringify(map) });
  const evaluate = async expression => {
    const result = await fixture.evaluate(expression);
    if (fixture.calls.length) current = false;
    return result;
  };
  assert.equal(await detectBrowserSource(evaluate, selector, origin, () => current), undefined);
  assert.equal(fixture.calls.length, 1);
});

test('editable controls stay opaque and oversized resource bodies are cancelled', async () => {
  const fixture = page(`{_debugSource:{fileName:'src/App.tsx',lineNumber:1}}`, { [origin + '/large.js']: 'x'.repeat(2_097_153) });
  runInContext('node.closest = () => node', fixture.context);
  assert.equal(await detectBrowserSource(fixture.evaluate, selector, origin, () => true), undefined);
  assert.equal(await fixture.evaluate(sourceResourceExpression(origin + '/large.js')), null);
});

test('a stalled source fetch aborts and releases its timer', async () => {
  const fixture = page('{}');
  let aborted = false;
  fixture.context.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true });
  });
  assert.equal(await fixture.evaluate(sourceResourceExpression(origin + '/stalled.js')), null);
  assert.equal(aborted, true);
});

test('resource reads are bounded and duplicate stack frames reuse the pick-local response', async () => {
  const metadata = String.raw`{_debugStack:Object.assign(new Error(),{stack:'Error\n at A (${origin}/bundle.js:10:1)\n at B (${origin}/bundle.js:2:1)'})}`;
  const fixture = page(metadata, { [origin + '/bundle.js']: '//# sourceMappingURL=bundle.js.map', [origin + '/bundle.js.map']: JSON.stringify(map) });
  assert.equal((await detectBrowserSource(fixture.evaluate, selector, origin, () => true)).line, 2);
  assert.equal(fixture.calls.length, 2, 'Read each resource once, including through duplicate stack frames');
  const paths = Array.from({ length: 8 }, (_, index) => origin + '/file' + index + '.js');
  const many = page(`{_debugStack:Object.assign(new Error(),{stack:${JSON.stringify('Error\n' + paths.map(url => ' at A (' + url + ':1:1)').join('\n'))}})}`, Object.fromEntries(paths.map(url => [url, 'compiled'])));
  assert.equal(await detectBrowserSource(many.evaluate, selector, origin, () => true), undefined);
  assert.equal(many.calls.length, 4);
});
