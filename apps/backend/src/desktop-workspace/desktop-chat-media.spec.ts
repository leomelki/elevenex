import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMedia, readChatMedia } from './desktop-chat-media.js';
import { chatItem } from './desktop-chat-projection.js';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const source = `data:image/png;base64,${png}`;
const item = (content: string): AgentTranscriptItem => ({
  id: 'image-result',
  kind: 'tool_result',
  content,
  timestamp: '2026-11-01T12:00:00Z',
});

describe('chat image boundaries', () => {
  let root: string;
  let workspace: string;
  const home = process.env.CODEX_HOME;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'elevenex-chat-media-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    process.env.CODEX_HOME = join(root, 'codex');
    await mkdir(join(root, 'codex', 'generated_images'), { recursive: true });
  });
  afterEach(async () => {
    if (home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = home;
    await rm(root, { recursive: true, force: true });
  });

  it('keeps generatedImage/MCP/native images out of text and sends references only', () => {
    for (const block of [
      { type: 'image', data: png, mimeType: 'image/png' },
      { type: 'inputImage', imageUrl: source },
      { image_url: source, output_hint: 'generated' },
    ]) {
      const raw = item(JSON.stringify({ content: [block] }));
      const projection = chatItem(raw);
      expect(projection.media).toHaveLength(1);
      expect(JSON.stringify(projection)).not.toContain(png);
      expect(projection.truncated).toBe(false);
      expect(chatMedia(raw).media[0].source).toBe(source);
    }
  });
  it('preserves text alongside images when history has already extracted the prose', () => {
    const raw = {
      ...item('Here is your robot'),
      providerToolResult: [{ type: 'output_image', image_url: source }],
    };
    expect(chatMedia(raw).text).toBe('Here is your robot');
    expect(chatMedia(raw).media).toHaveLength(1);
  });
  it('loads workspace images and Codex generated images outside the checkout', async () => {
    await writeFile(join(workspace, 'image.png'), Buffer.from(png, 'base64'));
    const generated = join(root, 'codex', 'generated_images', 'robot.png');
    await writeFile(generated, Buffer.from(png, 'base64'));
    await expect(readChatMedia('image.png', workspace, 'claude')).resolves.toBe(
      source,
    );
    await expect(readChatMedia(generated, workspace, 'codex')).resolves.toBe(
      source,
    );
    await expect(readChatMedia(generated, workspace, 'claude')).rejects.toThrow(
      'outside',
    );
  });
  it('rejects traversal, sibling prefix escapes, symlink escapes, remote URLs and non-images', async () => {
    const outside = join(root, 'private.png');
    await writeFile(outside, Buffer.from(png, 'base64'));
    await symlink(outside, join(workspace, 'escape.png'));
    await mkdir(workspace + '-other');
    await writeFile(
      join(workspace + '-other', 'image.png'),
      Buffer.from(png, 'base64'),
    );
    for (const path of [
      '../private.png',
      'escape.png',
      '../workspace-other/image.png',
      'https://example.com/image.png',
    ])
      await expect(readChatMedia(path, workspace, 'codex')).rejects.toThrow();
    await writeFile(join(workspace, 'fake.png'), '<script>execute()</script>');
    await expect(readChatMedia('fake.png', workspace, 'codex')).rejects.toThrow(
      'Unsupported',
    );
    await expect(
      readChatMedia('data:image/svg+xml;base64,PHN2Zz4=', workspace, 'codex'),
    ).rejects.toThrow();
  });
  it('only identifies explicit Markdown embeds as readable file references', () => {
    const raw = {
      ...item('![Robot](robot.png)\n\n[Secret](../secret.png)'),
      kind: 'assistant' as const,
    };
    expect(chatMedia(raw).media).toEqual([
      {
        id: '0',
        path: 'robot.png',
        source: 'robot.png',
        caption: 'Robot',
        inline: false,
      },
    ]);
  });
});
