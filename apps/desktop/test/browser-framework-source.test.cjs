const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createContext, runInContext } = require('node:vm');
const { detectBrowserSources, browserComponentSource, browserSourceLocation } = require('@elevenex/browser-inspection');

const selector = 'html > body:nth-child(1) > button:nth-child(1)';
function page(setup = '', attributes = {}) {
  const context = createContext({ attributes });
  runInContext(`const node = {closest:()=>null, parentElement:null, getAttribute:name=>attributes[name]??null};
    globalThis.document={querySelector:()=>node}; ${setup}`, context);
  return { context, detect: () => detectBrowserSources(async expression => runInContext(expression, context), selector, 'http://localhost:3000', () => true) };
}

for (const [legacy, line] of [[true, 87], [false, 88]]) test(`Svelte ${legacy ? '4' : '5'} reports one-based element coordinates`, async () => {
  const fixture = page(`node.__svelte_meta={loc:{file:'src/Checkout.svelte',line:${line},column:2${legacy ? ',char:120' : ''}}};`);
  assert.deepEqual(await fixture.detect(), { source: { file: 'src/Checkout.svelte', line: 88, column: 3, kind: 'svelte-metadata' } });
});

test('Angular compiler locations resolve external HTML templates and zero-based coordinates', async () => {
  assert.deepEqual(await page('', { 'data-ng-source-location': 'src/checkout.component.html@o:28,l:87,c:2' }).detect(), { source: { file: 'src/checkout.component.html', line: 88, column: 3, kind: 'angular-template' } });
});

test('Angular class declarations remain distinct from exact template locations', async () => {
  const fixture = page(`class Checkout {};
    Checkout.ɵcmp={debugInfo:{filePath:'src/checkout.component.ts',lineNumber:7}};
    const component=new Checkout();
    globalThis.ng={getComponent:()=>null,getOwningComponent:()=>component};`);
  assert.deepEqual(await fixture.detect(), { componentSource: { file: 'src/checkout.component.ts', line: 7, framework: 'angular' } });
  fixture.context.attributes['data-ng-source-location'] = 'src/checkout.component.html@o:28,l:87,c:2';
  assert.equal((await fixture.detect()).source.kind, 'angular-template');
});

for (const setup of [
  `node.__vueParentComponent={type:{__file:'src/Checkout.vue'},get setupState(){throw Error('private')}};`,
  `node.__vueParentComponent={type:{},parent:{type:{__file:'src/Checkout.vue'}}};`,
  `node.__vueParentComponent={type:{__file:'node_modules/ui/Button.vue'},parent:{type:{__file:'src/Checkout.vue'}}};`,
  `node.__vue__={$options:{__file:'src/Checkout.vue'}};`,
]) test('Vue component files remain useful without inventing a line', async () => {
  assert.deepEqual(await page(setup).detect(), { componentSource: { file: 'src/Checkout.vue', framework: 'vue' } });
});

test('Vue Inspector 7 resolves by opaque VNode identity without reading application props', async () => {
  const fixture = page(`const props={get secret(){throw Error('private')}};node.__vnode={props};
    globalThis.__vue_inspector_store__={vnodeToPos:new WeakMap([[props,['src/Checkout.vue',88,3]]])};
    node.__vueParentComponent={type:{__file:'src/Fallback.vue'}};`);
  assert.deepEqual(await fixture.detect(), { source: { file: 'src/Checkout.vue', line: 88, column: 3, kind: 'vue-inspector' } });
});

test('Vue hidden inspector metadata and visible legacy markers interoperate', async () => {
  assert.equal((await page(`node.__vnode={props:{__v_inspector:'src/Checkout.vue:88:3'}};`).detect()).source.line, 88);
  assert.equal((await page('', { 'data-v-inspector': 'src/Checkout.vue:88:3' }).detect()).source.kind, 'vue-inspector');
});

test('framework-neutral and Code Inspector markers support Windows paths and optional tag suffixes', async () => {
  for (const name of ['data-elevenex-source', 'data-insp-path']) {
    const result = await page('', { [name]: 'C:\\work\\src\\Checkout.vue:88:3' + (name === 'data-insp-path' ? ':button' : '') }).detect();
    assert.deepEqual(result, { source: { file: 'C:/work/src/Checkout.vue', line: 88, column: 3, kind: 'source-marker' } });
  }
});

test('nearest exact source outranks component files and ancestor metadata is labelled', async () => {
  const fixture = page(`node.__vueParentComponent={type:{__file:'src/Checkout.vue'}};
    node.parentElement={parentElement:null,getAttribute:name=>name==='data-elevenex-source'?'src/Parent.html:12:2':null};`);
  assert.deepEqual(await fixture.detect(), { source: { file: 'src/Parent.html', line: 12, column: 2, kind: 'source-marker', relation: 'ancestor' } });
  fixture.context.attributes['data-v-inspector'] = 'src/Checkout.vue:88:3';
  assert.equal((await fixture.detect()).source.file, 'src/Checkout.vue');
  assert.equal((await fixture.detect()).source.relation, undefined);
});

test('a broken framework/debug accessor or malformed marker cannot hide other valid metadata', async () => {
  const fixture = page(`globalThis.ng={getComponent:()=>{throw Error('unsupported')}};
    node.__vueParentComponent={type:{__file:'src/Checkout.vue'}};`, { 'data-elevenex-source': '../secret.ts:0:0', 'data-v-inspector': 'src/Checkout.vue:88:3' });
  assert.equal((await fixture.detect()).source.kind, 'vue-inspector');
  delete fixture.context.attributes['data-v-inspector'];
  assert.equal((await fixture.detect()).componentSource.file, 'src/Checkout.vue');
});

test('component hints are bounded and allowlisted independently of exact source metadata', () => {
  const component = { file: 'src/Checkout.vue', framework: 'vue' };
  assert.deepEqual(browserComponentSource({ ...component, text: 'secret', props: 'secret' }), component);
  for (const extra of [{ file: 'src/Checkout.vue?secret=1' }, { file: '../secret.vue' }, { line: 0 }, { line: 1.5 }, { column: 1 }, { framework: 'eval' }]) assert.equal(browserComponentSource({ ...component, ...extra }), undefined);
  assert.equal(browserSourceLocation({ file: 'src/Checkout.vue', kind: 'vue-inspector' }), undefined, 'Legacy exact source contracts still require a line');
});

test('adapters preserve opaque fields, cycle bounds and cancellation', async () => {
  const fixture = page(`node.__svelte_meta={loc:{file:'src/Checkout.svelte',line:88,column:2}};node.closest=()=>node;`);
  assert.deepEqual(await fixture.detect(), {});
  const cycle = page(`const vue={type:{}};vue.parent=vue;node.__vueParentComponent=vue;node.parentElement=node;`);
  assert.deepEqual(await cycle.detect(), {});
  assert.deepEqual(await detectBrowserSources(async () => { throw Error('must not run'); }, selector, 'http://localhost:3000', () => false), {});
});

test('failed source-map evaluation cannot hide a valid component fallback', async () => {
  const fixture = page(String.raw`node.__reactFiber$test={_debugStack:Object.assign(new Error(),{stack:'Error\n at App (http://localhost:3000/app.js:1:1)'})};node.__vueParentComponent={type:{__file:'src/Checkout.vue'}};`);
  let evaluations = 0;
  const result = await detectBrowserSources(async expression => {
    if (++evaluations > 1) throw Error('Resource evaluation failed');
    return runInContext(expression, fixture.context);
  }, selector, 'http://localhost:3000', () => true);
  assert.deepEqual(result, { componentSource: { file: 'src/Checkout.vue', framework: 'vue' } });
});

test('incompatible optional inspector/debug APIs retain the supported component fallback', async () => {
  const vue = page(`node.__vnode={props:{}};globalThis.__vue_inspector_store__={vnodeToPos:new Proxy(new WeakMap(),{})};node.__vueParentComponent={type:{__file:'src/Checkout.vue'}};`);
  assert.equal((await vue.detect()).componentSource.file, 'src/Checkout.vue');
  const angular = page(`class Checkout {};Checkout.ɵcmp={debugInfo:{filePath:'src/Checkout.ts',lineNumber:7}};const component=new Checkout();globalThis.ng={getComponent:()=>{throw Error('unsupported')},getOwningComponent:()=>component};`);
  assert.equal((await angular.detect()).componentSource.line, 7);
});
