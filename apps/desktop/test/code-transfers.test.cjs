const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { CodeTransfers } = require('../dist/code/transfers');
const { taskPath, transferName, TRANSFER_CHUNK } = require('../dist/code/transfer-contracts');
const { EXTENSION } = require('../dist/code/document');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function backend() {
  const entries = new Map([['/', null]]), pending = new Map(); let sequence = 0;
  const call = async (op, input, signal) => {
    signal.throwIfAborted();
    if (op === 'transfer-stat') return entries.has(input.path) ? { exists: true, type: entries.get(input.path) === null ? 2 : 1, size: entries.get(input.path)?.length ?? 0, revision: digest(entries.get(input.path) ?? Buffer.alloc(0)) } : { exists: false };
    if (op === 'mkdir') { entries.set(input.path, null); return { accepted: true }; }
    if (op === 'upload-begin') { const id = String(++sequence); pending.set(id, { ...input, chunks: [], offset: 0 }); return { id }; }
    if (op === 'upload-chunk') { const upload = pending.get(input.id); assert.equal(input.offset, upload.offset); const bytes = Buffer.from(input.content, 'base64'); assert.ok(bytes.length <= TRANSFER_CHUNK); upload.chunks.push(bytes); upload.offset += bytes.length; return { offset: upload.offset }; }
    if (op === 'upload-commit') { const upload = pending.get(input.id); entries.set(upload.path, Buffer.concat(upload.chunks)); pending.delete(input.id); return { accepted: true }; }
    if (op === 'upload-abort') { pending.delete(input.id); return { accepted: true }; }
    if (op === 'transfer-read') { const bytes = entries.get(input.path).subarray(input.offset, input.offset + TRANSFER_CHUNK); assert.equal(input.revision, digest(entries.get(input.path))); return { content: bytes.toString('base64'), offset: input.offset + bytes.length }; }
    if (op === 'directory') {
      const prefix = input.path.replace(/\/$/, '') + '/';
      const names = [...entries].filter(([path]) => path.startsWith(prefix) && path !== '/' && !path.slice(prefix.length).includes('/')).map(([path, bytes]) => ({ name: path.slice(prefix.length), type: bytes === null ? 2 : 1 })).filter(entry => entry.name > (input.after ?? '')).sort((a,b) => a.name < b.name ? -1 : 1);
      return { entries: names.slice(0,200), next: names.length > 200 ? names[199].name : null };
    }
    throw new Error('Unexpected operation ' + op);
  };
  return { entries, pending, call };
}
async function finish(transfers, id) {
  const start = Date.now();
  for (;;) { const state = transfers.status(id); if (state.phase !== 'running') return state; assert.ok(Date.now() - start < 10_000, 'Transfer deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-transfers-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('native file selection uploads multiple binary/empty files and skips existing files explicitly', () => fixture(async root => {
  const api = backend(), large = Buffer.alloc(9 * 1024 * 1024 + 1, 177);
  const sources = [join(root,'binary.bin'), join(root,'empty'), join(root,'existing')];
  await Promise.all([writeFile(sources[0],large),writeFile(sources[1],''),writeFile(sources[2],'new')]);
  api.entries.set('/existing', Buffer.from('old'));
  const transfers = new CodeTransfers({ upload: async () => sources, replace: async () => 'skip', download: async () => undefined }, api.call);
  const { id } = transfers.start({ direction: 'upload', paths: ['/'] });
  assert.throws(() => transfers.start({ direction:'upload',paths:['/'] }), /already running/);
  const state = await finish(transfers,id);
  assert.equal(state.phase,'complete'); assert.equal(state.files,2); assert.equal(state.skipped,1);
  assert.deepEqual(api.entries.get('/binary.bin'),large); assert.equal(api.entries.get('/empty').length,0); assert.equal(api.entries.get('/existing').toString(),'old'); assert.equal(api.pending.size,0);
  assert.ok(!JSON.stringify(state).includes(root)); transfers.dispose();
}));

test('folder upload/download preserves nested and empty folders, excludes Git metadata and symlinks, and pages large directories', () => fixture(async root => {
  const source = join(root,'source'), target = join(root,'downloaded'); await mkdir(source); await mkdir(join(source,'empty')); await mkdir(join(source,'.git'));
  await writeFile(join(source,'.git','secret'),'hidden'); await symlink(root,join(source,'link'));
  await Promise.all(Array.from({length:205},(_,i)=>writeFile(join(source,`file-${String(i).padStart(3,'0')}`),`content ${i}`)));
  const api = backend(), transfers = new CodeTransfers({ upload: async () => [source], download: async () => target, replace: async () => 'replace' },api.call);
  let result = transfers.start({direction:'upload-folder',paths:['/']});
  const uploaded = await finish(transfers,result.id); assert.equal(uploaded.phase,'complete'); assert.equal(uploaded.files,205); assert.equal(uploaded.skipped,2);
  result = transfers.start({direction:'download',paths:['/source','/source/file-001']});
  const downloaded = await finish(transfers,result.id); assert.equal(downloaded.phase,'complete'); assert.equal(downloaded.files,205);
  assert.equal((await readdir(target)).length,206); assert.equal(await readFile(join(target,'file-204'),'utf8'),'content 204'); assert.deepEqual(await readdir(join(target,'empty')),[]);
  assert.deepEqual((await readdir(root)).sort(),['downloaded','source']); transfers.dispose();
}));

test('failed or cancelled downloads remove staging and leave the destination unchanged', () => fixture(async root => {
  for (const cancel of [false,true]) {
    const api = backend(), target = join(root,'target'); await writeFile(target,'original'); api.entries.set('/file',Buffer.alloc(TRANSFER_CHUNK + 1,1));
    let id, transfers;
    transfers = new CodeTransfers({upload:async()=>[],download:async()=>target,replace:async()=>'replace'},async(op,input,signal)=>{
      if(op === 'transfer-read') { if(cancel) transfers.status(id,true); else throw new Error('Connection dropped'); }
      return api.call(op,input,signal);
    });
    ({id} = transfers.start({direction:'download',paths:['/file']}));
    const state = await finish(transfers,id); assert.equal(state.phase,cancel?'cancelled':'failed'); assert.equal(state.files,0);
    assert.equal(await readFile(target,'utf8'),'original'); assert.deepEqual(await readdir(root),['target']); transfers.dispose();
  }
}));

test('download rejects a concurrent destination edit and does not clobber it', () => fixture(async root => {
  const api=backend(),target=join(root,'target'); await writeFile(target,'original'); api.entries.set('/file',Buffer.from('download'));
  const transfers=new CodeTransfers({upload:async()=>[],download:async()=>target,replace:async()=>'replace'},async(op,input,signal)=>{
    if(op === 'transfer-read') await writeFile(target,'external change'); return api.call(op,input,signal);
  });
  const {id}=transfers.start({direction:'download',paths:['/file']}); assert.equal((await finish(transfers,id)).phase,'failed');
  assert.equal(await readFile(target,'utf8'),'external change'); assert.deepEqual(await readdir(root),['target']); transfers.dispose();
}));

test('transfer requests cannot select a local path and menu commands stay task-scoped', () => {
  for(const path of ['/../outside','/.git/config','/folder/../secret','/a\\..\\b','//server/path']) assert.throws(()=>taskPath(path));
  for(const name of ['../escape','.git','a/b','a\\b','.elevenex-save-private']) assert.throws(()=>transferName(name));
  assert.equal(transferName('unicode é.bin'),'unicode é.bin');
  if(process.platform === 'win32') for(const name of ['CON.txt','alternate:stream']) assert.throws(()=>transferName(name));
  else assert.equal(transferName('unicode é #? +".ts'),'unicode é #? +".ts');
  const commands=EXTENSION.contributes.menus['explorer/context'];
  for(const id of ['upload','upload-folder']) assert.ok(commands.some(item=>item.command === 'elevenex.code.'+id && item.when.startsWith('resourceScheme == elevenex-task')));
});

test('private editor transfer API requires visibility and the current lease, never exposes chunk endpoints', async () => {
  const { CodeProtocol }=require('../dist/code/protocol');
  const scopeId='a'.repeat(36),generation='a'.repeat(64); let picks=0,release;
  const picker=new Promise(resolve=>{release=resolve;});
  const client={state:()=>({scope:{id:scopeId}}),execute:async()=>({ok:true,value:{exists:true,type:2,size:0,revision:generation}})};
  const host=new CodeProtocol(client,1,{scopeId,taskId:1},{version:1,taskId:1,identity:generation,storageIdentity:generation,name:'Task',branch:'task'},'', '',()=>false,()=>{},()=>{},'app://elevenex',generation,()=>{},{upload:async()=>{picks++;return picker;},download:async()=>undefined,downloadDirectory:async()=>undefined,replace:async()=>'skip'});
  const request=(operation,input={})=>host.handle(new globalThis.Request(`https://${host.authority}/api/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({generation,transportRevision:0,...input})}));
  try {
    const input={direction:'upload',paths:['/']};
    assert.equal((await request('transfer-start',input)).status,409);
    await request('ready');
    assert.equal((await request('transfer-start',input)).status,403); assert.equal(picks,0);
    host.active=true;
    const response=await request('transfer-start',input); assert.equal(response.status,200); const {id}=await response.json();
    assert.equal((await request('transfer-start',input)).status,400);
    assert.equal((await request('upload-chunk',{id,content:'YQ==',offset:0})).status,404);
    assert.equal((await request('transfer-status',{id:'wrong'})).status,400);
    assert.equal((await request('transfer-cancel',{id})).status,200); release([]);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await (await request('transfer-status',{id})).json()).phase,'cancelled');
    host.reset(); assert.equal((await request('transfer-status',{id})).status,409);
    assert.equal(picks,1);
  } finally {release([]);host.dispose();}
});

test('transfer replies reject invalid bytes, oversized pages and false publication receipts',()=>{
  const {transferReply}=require('../dist/code/transfer-contracts');
  assert.throws(()=>transferReply('upload-commit',{accepted:false}));
  assert.throws(()=>transferReply('upload-begin',{id:'not-an-id'}));
  assert.throws(()=>transferReply('transfer-read',{content:'not base64',offset:1}));
  assert.throws(()=>transferReply('directory',{entries:Array(201).fill({name:'file',type:1}),next:null}));
});

test('multi-selection download chooses one directory and applies explicit batch conflict choices', () => fixture(async root => {
  const api=backend(); api.entries.set('/a',Buffer.from('new a')); api.entries.set('/b',Buffer.from('new b')); api.entries.set('/c',Buffer.from('new c'));
  await writeFile(join(root,'a'),'old a'); await writeFile(join(root,'b'),'old b');
  let directories=0,confirmations=0;
  const transfers=new CodeTransfers({upload:async()=>[],download:async()=>{throw Error('Unexpected per-file picker');},downloadDirectory:async()=>{directories++;return root;},replace:async()=>{confirmations++;return 'skip-all';}},api.call);
  const {id}=transfers.start({direction:'download',paths:['/a','/b','/c']});const state=await finish(transfers,id);
  assert.equal(state.phase,'complete');assert.equal(state.files,1);assert.equal(state.skipped,2);assert.equal(directories,1);assert.equal(confirmations,1);
  assert.equal(await readFile(join(root,'a'),'utf8'),'old a');assert.equal(await readFile(join(root,'b'),'utf8'),'old b');assert.equal(await readFile(join(root,'c'),'utf8'),'new c');transfers.dispose();
}));
