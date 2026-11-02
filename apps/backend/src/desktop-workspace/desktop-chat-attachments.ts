import {
  BadRequestException,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getElevenexDataRoot } from '../config/app-data-paths.js';

export const attachmentRoot = (sessionId: number) =>
  join(getElevenexDataRoot(), 'chat-attachments', String(sessionId));
export const attachmentName = (name: string) =>
  name
    .normalize('NFC')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(-180) || 'file';
const uuid = /^[a-f0-9-]{36}$/;
interface Upload {
  readonly temp: string;
  readonly path: string;
  readonly size: number;
  offset: number;
  touched: number;
  busy: boolean;
}

/** Private app data, never repository files. Partial uploads expire; completed files
 * remain available to provider histories, including queued prompts and reopened tasks. */
@Injectable()
export class DesktopChatAttachments implements OnModuleDestroy {
  private readonly uploads = new Map<string, Upload>();
  private readonly expiry = setInterval(() => {
    for (const [key, upload] of this.uploads)
      if (!upload.busy && Date.now() - upload.touched > 600000) {
        this.uploads.delete(key);
        void rm(dirname(upload.temp), { force: true, recursive: true }).catch(
          () => undefined,
        );
      }
  }, 60000).unref();
  async onModuleDestroy() {
    clearInterval(this.expiry);
    await Promise.allSettled(
      [...this.uploads.values()].map((upload) =>
        rm(dirname(upload.temp), { force: true, recursive: true }),
      ),
    );
    this.uploads.clear();
  }
  async chunk(sessionId: number, raw: Record<string, unknown>) {
    const { id, name, size, offset, data } = raw;
    if (
      typeof id !== 'string' ||
      !uuid.test(id) ||
      typeof name !== 'string' ||
      !name ||
      name.length > 255 ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 20 * 1024 * 1024 ||
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof data !== 'string' ||
      data.length > 699052 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      throw new BadRequestException('Invalid attachment chunk.');
    const bytes = Buffer.from(data, 'base64');
    if (offset + bytes.length > size || (!bytes.length && size !== 0))
      throw new BadRequestException('Invalid attachment size.');
    const key = `${sessionId}:${id}`;
    let upload = this.uploads.get(key);
    if (!upload) {
      if (offset !== 0 || this.uploads.size >= 32)
        throw new BadRequestException(
          'Upload unavailable. Choose the file again.',
        );
      const directory = join(attachmentRoot(sessionId), id);
      // Exclusive directory creation also prevents an ID from replacing a completed file.
      await mkdir(attachmentRoot(sessionId), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, attachmentName(name));
      upload = {
        path,
        temp: join(directory, '.partial'),
        size,
        offset: 0,
        touched: Date.now(),
        busy: false,
      };
      this.uploads.set(key, upload);
    }
    if (
      upload.busy ||
      upload.offset !== offset ||
      upload.size !== size ||
      upload.path !== join(attachmentRoot(sessionId), id, attachmentName(name))
    )
      throw new BadRequestException('Upload changed. Choose the file again.');
    upload.busy = true;
    try {
      const file = await open(
        upload.temp,
        (offset === 0
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          : constants.O_RDWR) |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!result.bytesWritten)
            throw new Error('Attachment write interrupted.');
          written += result.bytesWritten;
        }
        if (offset + bytes.length === size) await file.sync();
      } finally {
        await file.close();
      }
      upload.offset += bytes.length;
      upload.touched = Date.now();
      if (upload.offset === size) {
        await rename(upload.temp, upload.path);
        this.uploads.delete(key);
        return { id, offset: upload.offset, path: upload.path };
      }
      return { id, offset: upload.offset, path: null };
    } finally {
      upload.busy = false;
    }
  }
}
