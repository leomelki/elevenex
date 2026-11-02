import { attachmentRoot } from './desktop-chat-attachments.js';
import { BadRequestException } from '@nestjs/common';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_DATA = Math.ceil((8 * 1024 * 1024) / 3) * 4;
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
interface ChatMedia {
  readonly kind?: 'image' | 'video' | 'file';
  readonly id: string;
  readonly path: string;
  readonly caption: string;
  readonly inline: boolean;
  readonly source: string;
}

/** Binary content travels only on demand, never through transcript text pages. */
export function chatMedia(item: AgentTranscriptItem) {
  const media: ChatMedia[] = [];
  const add = (source: string, path?: string, caption = 'Image') => {
    if (!source || source.length > MAX_DATA + 100 || media.length >= 12) return;
    if (source.startsWith('data:')) {
      if (!/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(source)) return;
    } else if (
      source.length > 4000 ||
      (!isAbsolute(source) && /^[a-z][a-z\d+.-]*:/i.test(source)) ||
      source.startsWith('//') ||
      source.startsWith('\\\\')
    )
      return;
    const id = String(media.length);
    const target =
      path ??
      (source.startsWith('data:')
        ? `chat-image-${encodeURIComponent(item.id)}-${id}`
        : source);
    if (media.some((m) => m.path === target || m.source === source)) return;
    media.push({
      id,
      path: target,
      caption: caption.slice(0, 200),
      inline: path === undefined,
      source,
    });
  };
  for (const image of item.images?.slice(0, 12) ?? [])
    add(`data:${image.mediaType};base64,${image.data}`);
  let visited = 0;
  let shortened = false;
  const clean = (value: unknown, depth = 0): unknown => {
    if (++visited > 400 || depth > 10) {
      shortened = true;
      return '[Additional content omitted]';
    }
    if (typeof value === 'string') {
      if (/^data:image\//i.test(value)) {
        add(value);
        return '[Image attachment]';
      }
      if (/^\s*[{[]/.test(value)) {
        try {
          return clean(JSON.parse(value) as unknown, depth + 1);
        } catch {
          /* Plain tool text. */
        }
      }
      return value;
    }
    const data = object(value);
    if (
      ['image', 'input_image', 'output_image', 'inputImage'].includes(
        String(data.type),
      ) ||
      typeof data.image_url === 'string'
    ) {
      const url = data.image_url ?? data.imageUrl ?? data.url;
      const source = typeof url === 'string' ? url : object(url).url;
      if (typeof source === 'string') add(source);
      else if (typeof data.data === 'string')
        add(
          `data:${String(data.mimeType ?? data.mime_type ?? 'image/png')};base64,${data.data}`,
        );
      else if (typeof data.source === 'object') {
        const source = object(data.source);
        if (typeof source.data === 'string')
          add(
            `data:${String(source.media_type ?? 'image/png')};base64,${source.data}`,
          );
      }
      return { type: 'image', text: 'Image attachment' };
    }
    if (Array.isArray(value)) {
      shortened ||= value.length > 400;
      return value.slice(0, 400).map((v) => clean(v, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(data);
      shortened ||= entries.length > 400;
      return Object.fromEntries(
        entries.slice(0, 400).map(([key, v]) => [key, clean(v, depth + 1)]),
      );
    }
    return value;
  };
  const original =
    item.content ?? item.providerToolResult ?? item.agentMessage?.body ?? '';
  const cleaned = item.kind === 'tool_result' ? clean(original) : original;
  if (item.content !== undefined && item.providerToolResult !== undefined)
    clean(item.providerToolResult);
  const text =
    typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned, null, 2);
  // Only actual image embeds authorize a path read; links and tool input do not.
  if (item.kind === 'assistant' || item.kind === 'user')
    for (const match of text.matchAll(/^!\[([^\]]*)\]\(([^)\r\n]+)\)\s*$/gm))
      if (
        match[2].length <= 4000 &&
        (isAbsolute(match[2]) || !/^[a-z][a-z\d+.-]*:|^\/\//i.test(match[2]))
      )
        add(match[2], match[2], match[1]);
  const uploaded: ChatMedia[] = [];
  if (item.kind === 'user') {
    for (const match of text.matchAll(
      /^\[([^\]\r\n]+)\]\(<([^>\r\n]+)>\)\s*$/gm,
    )) {
      // Only our private upload namespace creates file cards, never arbitrary Markdown links.
      if (
        !uploadedAttachment(match[2]) ||
        uploaded.length >= 8 ||
        uploaded.some((value) => value.source === match[2])
      )
        continue;
      const source = match[2];
      uploaded.push({
        id: String(uploaded.length),
        path: source,
        source,
        caption: match[1].slice(0, 200),
        inline: false,
        kind: attachmentKind(source),
      });
    }
  }
  const selected = item.kind === 'user' && uploaded.length ? uploaded : media;
  return {
    text,
    media: selected.map((value, index) => ({ ...value, id: String(index) })),
    shortened,
  };
}

export function uploadedAttachment(path: string, sessionId?: number): boolean {
  const root = attachmentRoot(sessionId ?? 1);
  const base = sessionId === undefined ? resolve(root, '..') : root;
  const child = relative(base, path).split(sep);
  return (
    isAbsolute(path) &&
    (sessionId === undefined
      ? child.length === 3 && /^\d+$/.test(child.shift() ?? '')
      : child.length === 2) &&
    /^[a-f0-9-]{36}$/.test(child[0]) &&
    /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,179}$/.test(child[1])
  );
}
export function attachmentKind(path: string): 'image' | 'video' | 'file' {
  return /\.(png|jpe?g|gif|webp)$/i.test(path)
    ? 'image'
    : /\.(mp4|webm|mov|m4v|ogv)$/i.test(path)
      ? 'video'
      : 'file';
}
export function imageType(bytes: Buffer): string | undefined {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')))
    return 'image/gif';
  if (
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}
const within = (root: string, path: string) => {
  const child = relative(root, path);
  return (
    child !== '' &&
    !isAbsolute(child) &&
    child !== '..' &&
    !child.startsWith('..' + sep)
  );
};

/** The caller first verifies session membership and selects a transcript attachment.
 * Generated images live outside checkouts; allow that one agent-owned directory,
 * never the whole home directory. Resolve symlinks before enforcing confinement. */
export async function readChatMedia(
  source: string,
  workspace: string,
  provider: string,
  sessionId?: number,
) {
  let bytes: Buffer;
  const data =
    /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      source,
    );
  if (data) {
    if (data[1].length > MAX_DATA)
      throw new BadRequestException('Image is too large.');
    bytes = Buffer.from(data[1], 'base64');
  } else {
    if (
      !source ||
      source.length > 4000 ||
      (!isAbsolute(source) && /^[a-z][a-z\d+.-]*:/i.test(source)) ||
      source.startsWith('//') ||
      source.startsWith('\\\\') ||
      source.includes('\0')
    )
      throw new BadRequestException('Unsupported image source.');
    const roots = [
      workspace,
      ...(sessionId !== undefined && uploadedAttachment(source, sessionId)
        ? [attachmentRoot(sessionId)]
        : []),
      ...(provider === 'codex'
        ? [
            join(
              process.env.CODEX_HOME || join(homedir(), '.codex'),
              'generated_images',
            ),
          ]
        : []),
    ];
    const path = await realpath(resolve(workspace, source));
    const allowed = await Promise.all(
      roots.map((root) => realpath(root).catch(() => null)),
    );
    if (!allowed.some((root) => root && within(root, path)))
      throw new BadRequestException(
        'Image is outside this session’s allowed folders.',
      );
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw new BadRequestException('Image is unavailable or too large.');
      // Bound the read even if a file grows after stat.
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size)
        throw new BadRequestException(
          'Image changed while loading. Try again.',
        );
      bytes = buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
  }
  const type =
    imageType(bytes) ??
    (sessionId !== undefined &&
    uploadedAttachment(source, sessionId) &&
    attachmentKind(source) === 'video'
      ? bytes.subarray(4, 8).toString() === 'ftyp'
        ? 'video/mp4'
        : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
          ? 'video/webm'
          : bytes.subarray(0, 4).toString() === 'OggS'
            ? 'video/ogg'
            : undefined
      : undefined);
  if (
    !type ||
    bytes.length > (type.startsWith('image/') ? 8 * 1024 * 1024 : MAX_BYTES)
  )
    throw new BadRequestException('Unsupported or oversized image.');
  return `data:${type};base64,${bytes.toString('base64')}`;
}
