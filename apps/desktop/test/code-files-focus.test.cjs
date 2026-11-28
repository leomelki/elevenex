const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

test('Files cover ignores folders, picker/rename focus and modified clicks; accepting a file dismisses once and disposes listeners',async()=>{
  class Element {
    constructor(kind){this.kind=kind;}
    closest(selector){return selector==='.monaco-editor'?(this.kind==='editor'?this:null):selector.includes('input,')?(this.kind==='input'?this:null):['folder','file'].includes(this.kind)?this:null;}
    hasAttribute(name){return name==='aria-expanded'&&this.kind==='folder';}
  }
  const listeners=new Map(), classes=new Set();let calls=0;
  const root={body:{classList:{toggle:(name,value)=>value?classes.add(name):classes.delete(name)}},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{assert.equal(fn,listeners.get(name));listeners.delete(name);}};
  const exports={};
  vm.runInNewContext(await readFile(require.resolve('../dist/code/web/files-focus.js'),'utf8'),{exports,Element});
  const focus=new exports.FilesFocus(root,async()=>{calls++;});
  const click=(kind,extra={})=>listeners.get('click')({target:new Element(kind),button:0,...extra});
  click('file');assert.equal(calls,0);
  focus.setBrowsing(true);
  assert.equal(classes.has('elevenex-compact-files'),true);
  click('folder');click('input');click('file',{metaKey:true});assert.equal(calls,0);
  listeners.get('focusin')({target:new Element('input')});assert.equal(calls,0);
  click('file');click('file');assert.equal(calls,1);
  assert.equal(classes.has('elevenex-compact-files'),false);
  focus.setBrowsing(true);listeners.get('focusin')({target:new Element('editor')});assert.equal(calls,2);
  focus.setBrowsing(true);focus.dispose();assert.equal(listeners.size,0);assert.equal(classes.size,0);
});
