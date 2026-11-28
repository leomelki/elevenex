import { BadRequestException } from '@nestjs/common';
import { parseBrowserElements } from '@elevenex/shared';
import type { AgentImageInput, AgentRuntimeProvider } from '../agent-runtime/agent-runtime.types.js';
import { chatMedia, readChatMedia, uploadedAttachment } from './desktop-chat-media.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Resolve only session-owned uploads. Native images from saved prompts never leave the engine. */
export async function chatPromptImages(
  text: string,
  sessionId: number,
  worktreePath: string,
  provider: AgentRuntimeProvider,
  saved: readonly AgentImageInput[] = [],
): Promise<AgentImageInput[] | undefined> {
  const refs = chatMedia({ id: 'send', kind: 'user', content: text, timestamp: '' }).media
    .filter(media => media.kind === 'image' && uploadedAttachment(media.source, saved.length ? undefined : sessionId));
  const elements = parseBrowserElements(text).elements;
  const multimodal = provider.info.capabilities?.multimodalPrompts;
  if (elements.length && !multimodal)
    throw new BadRequestException('This harness cannot receive element images.');
  const images = [...saved];
  if (images.length > 8 || images.some(image => !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) ||
      images.reduce((size, image) => size + Buffer.byteLength(image.data, 'base64'), 0) > MAX_IMAGE_BYTES)
    throw new BadRequestException('Saved image attachments cannot be resent within the input limit.');
  if (!saved.length) {
    let bytes = 0;
    for (const ref of refs) {
      const source = await readChatMedia(ref.source, worktreePath, provider.info.id, sessionId);
      const [header, data] = source.split(',');
      bytes += Buffer.byteLength(data, 'base64');
      if (bytes > MAX_IMAGE_BYTES)
        throw new BadRequestException('Image attachments exceed the native input limit.');
      const mediaType = header.slice(5, -7);
      if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/gif' && mediaType !== 'image/webp')
        throw new BadRequestException('Unsupported image input.');
      images.push({ mediaType, data });
    }
  }
  if (elements.some(element =>
    refs.findIndex(ref => ref.caption === element.attachment) + 1 !== element.imageIndex ||
    !images[element.imageIndex - 1]))
    throw new BadRequestException('Element screenshot attachment is missing.');
  return images.length && multimodal ? images : undefined;
}
