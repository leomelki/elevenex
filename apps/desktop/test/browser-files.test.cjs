const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { RemoteBrowserFiles } = require('../dist/browser/remote-files');
const window = { isDestroyed: () => false };
const upload = { id: 'request', kind: 'upload', multiple: true };
const download = { id: 'request', kind: 'download', name: 'result.txt', status: 'ready' };
test('native selection sends bounded file bytes without local paths and always releases the request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ex-upload-test-'));
  try {
    const path = join(root, 'private-path.txt'); await writeFile(path, Buffer.alloc(100000, 65));
    const sent = [], canceled = [];
    const files = new RemoteBrowserFiles(window, () => true, async body => { sent.push(body); return {}; }, async (...args) => canceled.push(args), { showOpenDialog: async () => ({ canceled: false, filePaths: [path] }) });
    await files.run('tab', upload);
    assert.equal(sent[0].transfer.files[0].name, 'private-path.txt');
    assert.equal(JSON.stringify(sent).includes(root), false);
    const chunks = sent.filter(body => body.transfer.kind === 'upload-chunk').map(body => body.transfer);
    assert.ok(chunks.every(body => Buffer.from(body.data, 'base64').length <= 48 * 1024));
    assert.deepEqual(Buffer.concat(chunks.map(body => Buffer.from(body.data, 'base64'))), Buffer.alloc(100000, 65));
    assert.deepEqual(canceled, [['tab', 'request']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('interrupted downloads preserve an existing destination and delete temporary bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ex-download-test-'));
  try {
    const path = join(root, 'result.txt'); await writeFile(path, 'original'); let canceled = 0;
    const files = new RemoteBrowserFiles(window, () => true, async () => ({ size: 4, offset: 0, data: 'bad' }), async () => canceled++, { showSaveDialog: async () => ({ canceled: false, filePath: path }) });
    await assert.rejects(files.run('tab', download), /Invalid download/);
    assert.equal(await readFile(path, 'utf8'), 'original'); assert.deepEqual(await readdir(root), ['result.txt']); assert.equal(canceled, 1);
    const good = new RemoteBrowserFiles(window, () => true, async () => ({ size: 4, offset: 0, data: 'ZmlsZQ==' }), async () => {}, { showSaveDialog: async () => ({ canceled: false, filePath: path }) });
    await good.run('tab', download); assert.equal(await readFile(path, 'utf8'), 'file');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('scope changes during native selection never dispatch an upload', async () => {
  let current = true, sent = 0, canceled = 0;
  const files = new RemoteBrowserFiles(window, () => current, async () => sent++, async () => canceled++, { showOpenDialog: async () => { current = false; return { canceled: false, filePaths: ['/unread'] }; } });
  await assert.rejects(files.run('tab', upload), /Browser changed/); assert.equal(sent, 0); assert.equal(canceled, 1);
});
