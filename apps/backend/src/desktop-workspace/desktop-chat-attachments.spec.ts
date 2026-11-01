import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopChatAttachments } from './desktop-chat-attachments.js';
import { chatMedia, readChatMedia } from './desktop-chat-media.js';

describe('session attachments', () => {
  let root: string,
    previous: string | undefined,
    uploads: DesktopChatAttachments;
  const id = '11111111-1111-4111-8111-111111111111';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-attachments-'));
    previous = process.env.ELEVENEX_DATA_ROOT;
    process.env.ELEVENEX_DATA_ROOT = root;
    uploads = new DesktopChatAttachments();
  });
  afterEach(async () => {
    await uploads.onModuleDestroy();
    if (previous === undefined) delete process.env.ELEVENEX_DATA_ROOT;
    else process.env.ELEVENEX_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const chunk = (offset: number, data: string, name = '../recording.webm') => ({
    id,
    name,
    size: 6,
    offset,
    data: Buffer.from(data).toString('base64'),
  });
  it('writes chunks at their explicit offsets and only publishes complete files', async () => {
    expect(await uploads.chunk(2, chunk(0, 'abc'))).toEqual({
      id,
      offset: 3,
      path: null,
    });
    const result = await uploads.chunk(2, chunk(3, 'def'));
    expect(result.path).toContain(join(root, 'chat-attachments', '2', id));
    expect(await readFile(result.path!, 'utf8')).toBe('abcdef');
    await expect(uploads.chunk(2, chunk(0, 'abc'))).rejects.toThrow();
  });
  it('keeps all eight uploaded images when provider history repeats native image blocks', () => {
    const paths = Array.from({ length: 8 }, (_, index) =>
      join(
        root,
        'chat-attachments',
        '2',
        `${index}1111111-1111-4111-8111-111111111111`,
        'reference.png',
      ),
    );
    const projected = chatMedia({
      id: 'user',
      kind: 'user',
      timestamp: '',
      content: paths.map((path) => `[reference.png](<${path}>)`).join('\n\n'),
      images: paths.map(() => ({
        mediaType: 'image/png',
        data: 'iVBORw0KGgo=',
      })),
    });
    expect(projected.media).toHaveLength(8);
    expect(projected.media.map((media) => media.path)).toEqual(paths);
  });

  it('rejects out-of-order/oversized/malformed chunks and cross-session continuation', async () => {
    await uploads.chunk(2, chunk(0, 'abc'));
    await expect(uploads.chunk(2, chunk(1, 'def'))).rejects.toThrow();
    await expect(uploads.chunk(3, chunk(3, 'def'))).rejects.toThrow();
    await expect(
      uploads.chunk(2, { ...chunk(3, 'def'), data: '!!' }),
    ).rejects.toThrow();
    await expect(
      uploads.chunk(2, { ...chunk(3, 'def'), size: 21 * 1024 * 1024 }),
    ).rejects.toThrow();
  });
  it('persists video references through projection and confines reads to the owning session', async () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]);
    const result = await uploads.chunk(2, {
      ...chunk(0, ''),
      name: 'recording.webm',
      data: bytes.toString('base64'),
    });
    const projected = chatMedia({
      id: 'user',
      kind: 'user',
      timestamp: '',
      content: `[recording.webm](<${result.path}>)`,
    });
    expect(projected.media[0]).toMatchObject({
      kind: 'video',
      caption: 'recording.webm',
    });
    expect(
      await readChatMedia(result.path!, root + '/checkout', 'codex', 2),
    ).toMatch(/^data:video\/webm;base64,/);
    await expect(
      readChatMedia(result.path!, root + '/checkout', 'codex', 3),
    ).rejects.toThrow();
  });
});
