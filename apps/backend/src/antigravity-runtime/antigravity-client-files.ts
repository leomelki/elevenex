import { BadRequestException } from '@nestjs/common';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { codeRead } from '../code-workspace/code-files.js';
import { attachmentRoot } from '../desktop-workspace/desktop-chat-attachments.js';
import { uploadedAttachment } from '../desktop-workspace/desktop-chat-media.js';

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new BadRequestException('Invalid Antigravity file range.');
  return value;
}

/** ACP file reads use the same bounded, symlink-confined reader as the Code view. */
export async function readAntigravityTextFile(
  workspace: string,
  sessionId: number,
  request: Record<string, unknown>,
) {
  const { path } = request;
  if (
    typeof path !== 'string' ||
    !path.length ||
    path.length > 4000 ||
    path.includes('\0') ||
    path.startsWith('//') ||
    path.startsWith('\\\\')
  )
    throw new BadRequestException('Invalid Antigravity file path.');
  const start = (positiveInteger(request.line) ?? 1) - 1;
  const limit = positiveInteger(request.limit);
  const target = resolve(workspace, path);
  const lexicalRoot = uploadedAttachment(target, sessionId)
    ? attachmentRoot(sessionId)
    : workspace;
  const child = relative(lexicalRoot, target);
  if (
    !child ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new BadRequestException('Antigravity file is outside this session.');
  const root = await realpath(lexicalRoot);
  const { content } = await codeRead(
    { root },
    '/' + child.split(sep).join('/'),
  );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.from(content, 'base64'),
  );
  if (text.includes('\0'))
    throw new BadRequestException('Antigravity requires a text file.');
  if (start === 0 && limit === undefined) return { content: text };
  let offset = 0;
  for (let index = 0; index < start; index++) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return { content: '' };
    offset = newline + 1;
  }
  if (limit === undefined) return { content: text.slice(offset) };
  let end = offset - 1;
  for (let index = 0; index < limit; index++) {
    end = text.indexOf('\n', end + 1);
    if (end < 0) return { content: text.slice(offset) };
  }
  return { content: text.slice(offset, end) };
}
