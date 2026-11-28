const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

async function mount(persisted = new Map(), values = new Map(), initialTabs = []) {
  const calls = [], updates = [], groups = [{tabs:initialTabs}];
  Object.defineProperty(groups[0],'activeTab',{get:()=>groups[0].tabs[0]});
  let changed, focused, disposed = 0;
  const state = { get: key => globalThis.structuredClone(persisted.get(key)), update: async (key,value) => {persisted.set(key,globalThis.structuredClone(value));} };
  const vscode = {
    ConfigurationTarget:{Global:1},
    window:{tabGroups:{activeTabGroup:groups[0],all:groups,onDidChangeTabs:listener=>{changed=listener;return {dispose:()=>disposed++};}},onDidChangeActiveTextEditor:listener=>{focused=listener;return {dispose:()=>disposed++};}},
    workspace:{getConfiguration:()=>({inspect:key=>({globalValue:values.get(key)}),update:async(key,value,target)=>{assert.equal(target,1);values.set(key,value);updates.push(key);}})},
    commands:{executeCommand:async(...args)=>{calls.push(args);}},
  };
  const exports={};
  vm.runInNewContext(await readFile(require.resolve('../dist/code/web/compact-layout.js'),'utf8'),{exports,require:name=>{assert.equal(name,'vscode');return vscode;}});
  const layout=new exports.CompactLayout(state);
  return {layout,calls,updates,groups,disposed:()=>disposed,tabs:async(tabs,selected=false)=>{groups[0].tabs=tabs;changed({opened:selected?tabs:[],closed:[],changed:[]});await layout.set(true);},focus:async(editor)=>{focused(editor);await layout.set(true);}};
}

test('compact mode restores journaled preferences and the original Explorer after reload',async()=>{
  const values=new Map([['workbench.activityBar.location','top'],['editor.wordWrap','bounded']]),persisted=new Map();
  const first=await mount(persisted,values,[{}]);
  await first.layout.set(true);await first.layout.set(true);
  assert.equal(first.updates.length,2);assert.equal(values.get('editor.wordWrap'),'on');first.layout.dispose();
  const restored=await mount(persisted,values,[{}]);await restored.layout.set(true);await restored.layout.set(false);
  assert.equal(values.get('workbench.activityBar.location'),'top');assert.equal(values.get('editor.wordWrap'),'bounded');
  assert.ok(restored.calls.some(([id,args])=>id==='vscode.moveViews'&&args.destinationId==='workbench.view.explorer'));
  const count=restored.updates.length;await restored.layout.set(false);assert.equal(restored.updates.length,count);restored.layout.dispose();
});
test('empty compact workbenches show the real Files tree; accepting a file restores the editor',async()=>{
  const host=await mount();await host.layout.set(true);
  assert.ok(host.calls.some(([id])=>id==='workbench.action.maximizeAuxiliaryBar'));
  await host.layout.dismiss(); // There is nothing to return to yet.
  assert.equal(host.calls.filter(([id])=>id==='workbench.action.focusActiveEditorGroup').length,0);
  await host.tabs([{}],true);
  assert.ok(host.calls.some(([id])=>id==='workbench.action.restoreAuxiliaryBar'));
  assert.ok(host.calls.some(([id])=>id==='workbench.action.focusActiveEditorGroup'));
  const before=host.calls.filter(([id])=>id==='workbench.action.maximizeAuxiliaryBar').length;
  await host.tabs([]);assert.equal(host.calls.filter(([id])=>id==='workbench.action.maximizeAuxiliaryBar').length,before+1);
  host.layout.dispose();assert.equal(host.disposed(),2);
});
test('browsing preserves open editors; repeated requests focus the same tree and returning to an existing file dismisses it',async()=>{
  const host=await mount(new Map(),new Map(),[{}]);await host.layout.set(true);
  assert.equal(host.calls.some(([id])=>id==='workbench.action.maximizeAuxiliaryBar'),false);
  await host.layout.browse();await host.layout.browse();
  assert.equal(host.calls.filter(([id])=>id==='vscode.moveViews').length,1);
  await host.focus(undefined); // Tree focus is not an empty editor.
  const count=host.calls.filter(([id])=>id==='workbench.action.closeAuxiliaryBar').length;
  await host.focus({document:{}});assert.equal(host.calls.filter(([id])=>id==='workbench.action.closeAuxiliaryBar').length,count+1);
  assert.equal(host.groups[0].tabs.length,1);host.layout.dispose();
  const calls=host.calls.length;await host.layout.browse();assert.equal(host.calls.length,calls);
});
