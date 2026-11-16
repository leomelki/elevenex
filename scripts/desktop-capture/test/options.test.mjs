import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, checkpoint } from '../options.mjs';
import { escapeHtml } from '../report.mjs';

test('capture CLI rejects remote URLs, incompatible modes and unbounded dimensions', () => {
  for (const args of [['--url', 'https://example.com'], ['--url', 'http://user:pass@127.0.0.1:4300'], ['--width', '0'], ['--height', '8192'], ['--timeout', 'Infinity'], ['--theme', 'system'], ['--built', '--fixture'], ['--serve', 'scenario.mjs'], ['--unknown'], ['--backend-url', 'https://example.com'], ['--backend-url', 'http://user:secret@127.0.0.1:41273']]) {
    assert.throws(() => parseOptions(args), undefined, args.join(' '));
  }
  assert.equal(parseOptions(['--fixture', '--url', 'http://127.0.0.1:4310']).fixture, true);
  assert.equal(parseOptions(['--', '-', '--width', '900']).scenario, '-');
  assert.equal(parseOptions(['--backend-url', 'http://127.0.0.1:41273'])['backend-url'], 'http://127.0.0.1:41273');
});

test('checkpoint names cannot overwrite outputs or escape their directory', () => {
  const names = new Set();
  assert.deepEqual(checkpoint('ready', names), { name: 'ready' });
  for (const point of ['ready', '../escape', '', { name: 'x', inspect: Array(101).fill('div') }, { name: 'x', metadata: 'a'.repeat(65537) }, { name: 'x', script: 'bad' }]) {
    assert.throws(() => checkpoint(point, names));
  }
});

test('gallery text cannot inject scripts or attributes', () => {
  assert.equal(escapeHtml('<img onerror="x">&\''), '&lt;img onerror=&quot;x&quot;&gt;&amp;&#39;');
});
