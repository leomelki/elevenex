import { lstat, realpath } from 'node:fs/promises';
import { basename, extname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentImageInput } from '../agent-runtime/agent-runtime.types.js';
import { codeRead, confinedPath } from '../code-workspace/code-files.js';
import { attachmentRoot } from '../desktop-workspace/desktop-chat-attachments.js';
import {
  chatMedia,
  uploadedAttachment,
} from '../desktop-workspace/desktop-chat-media.js';

const AUDIO_TYPES = new Map([
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
]);
const TEXT_TYPES =
  /^(?:\.(?:txt|mdx?|jsonl?|ya?ml|toml|xml|csv|tsv|[cm]?jsx?|tsx?|html?|s?css|py|rs|go|java|kt|swift|c|h|cpp|rb|php|sh|bash|sql|svelte|vue|log|diff|patch|ini|conf))$/i;
const EMBED_LIMIT = 8 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

export interface AntigravityPromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'audio' | 'image'; data: string; mimeType: string }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      mimeType: string;
      size: number;
    }
  | {
      type: 'resource';
      resource: { uri: string; mimeType: string; text: string };
    };

/** Upload paths stay in the prompt as a fallback whenever the CLI cannot embed a file. */
export async function antigravityPrompt(
  sessionId: number,
  prompt: string,
  images: readonly AgentImageInput[],
  capabilities: AntigravityPromptCapabilities,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [
    { type: 'text', text: prompt },
    ...images.map(({ data, mediaType }) => ({
      type: 'image' as const,
      data,
      mimeType: mediaType,
    })),
  ];
  if (!capabilities.audio && !capabilities.embeddedContext) return blocks;
  const references = chatMedia({
    id: 'prompt',
    kind: 'user',
    content: prompt,
    timestamp: '',
  }).media;
  const owned = references.filter(
    ({ source, kind }) =>
      kind === 'file' && uploadedAttachment(source, sessionId),
  );
  if (!owned.length) return blocks;
  const uploadDirectory = attachmentRoot(sessionId);
  const root = await realpath(uploadDirectory).catch(() => undefined);
  if (!root) return blocks;
  let remaining = EMBED_LIMIT;
  for (const { source } of owned) {
    const ext = extname(source).toLowerCase();
    const audio = capabilities.audio ? AUDIO_TYPES.get(ext) : undefined;
    const pdf = capabilities.embeddedContext && ext === '.pdf';
    const text = capabilities.embeddedContext && TEXT_TYPES.test(ext);
    if (!audio && !pdf && !text) continue;
    const child = '/' + relative(uploadDirectory, source).split(sep).join('/');
    try {
      const file = await confinedPath({ root }, child);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.nlink !== 1) continue;
      const uri = pathToFileURL(file).href;
      if (pdf) {
        blocks.push({
          type: 'resource_link',
          uri,
          name: basename(file),
          mimeType: 'application/pdf',
          size: stat.size,
        });
        continue;
      }
      const limit = text ? Math.min(remaining, TEXT_LIMIT) : remaining;
      if (stat.size > limit) continue;
      const { content } = await codeRead({ root }, child);
      const size = Buffer.byteLength(content, 'base64');
      if (size > limit) continue;
      if (audio) {
        blocks.push({ type: 'audio', data: content, mimeType: audio });
      } else {
        const bytes = Buffer.from(content, 'base64');
        const encoding =
          bytes[0] === 0xff && bytes[1] === 0xfe
            ? 'utf-16le'
            : bytes[0] === 0xfe && bytes[1] === 0xff
              ? 'utf-16be'
              : 'utf-8';
        const decoded = new TextDecoder(encoding, { fatal: true }).decode(
          bytes,
        );
        if (decoded.includes('\0')) continue;
        blocks.push({
          type: 'resource',
          resource: { uri, mimeType: 'text/plain', text: decoded },
        });
      }
      remaining -= size;
    } catch {
      // The same user-visible link remains available if an upload cannot be embedded.
    }
  }
  return blocks;
}
