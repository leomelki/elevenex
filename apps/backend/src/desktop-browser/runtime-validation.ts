import { z } from 'zod';
const tabId = z.string().uuid();
const url = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !/\s/.test(value)
      );
    } catch {
      return false;
    }
  });
const unit = z.number().finite().min(0).max(16384),
  modifiers = z.number().int().min(0).max(15);
export const runtimeCommand = z.union([
  z.object({ kind: z.literal('new-tab') }).strict(),
  z.object({ kind: z.literal('dismiss-attention') }).strict(),
  z.object({ kind: z.literal('open'), url }).strict(),
  z
    .object({
      kind: z.enum([
        'select',
        'close',
        'back',
        'reload',
        'takeover',
        'outside',
        'focus',
      ]),
      tabId,
    })
    .strict(),
  z.object({ kind: z.literal('navigate'), tabId, url }).strict(),
  z
    .object({
      kind: z.literal('handoff'),
      tabId,
      sessionId: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('width'),
      tabId,
      width: z.enum(['full', 'phone']),
    })
    .strict(),
  z.object({ kind: z.literal('pick'), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('feedback'), enabled: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('theme'),
      tabId,
      theme: z.enum(['system', 'light', 'dark']),
    })
    .strict(),
  z.object({ kind: z.literal('network'), tabId, slow: z.boolean() }).strict(),
]);
const runtimeEvent = z.union([
  z
    .object({
      kind: z.literal('pointer'),
      type: z.enum(['down', 'up', 'move']),
      x: unit,
      y: unit,
      button: z.enum(['left', 'middle', 'right', 'none']),
      buttons: z.number().int().min(0).max(31),
      clicks: z.number().int().min(0).max(3),
      modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('wheel'),
      x: unit,
      y: unit,
      deltaX: z.number().finite().min(-10000).max(10000),
      deltaY: z.number().finite().min(-10000).max(10000),
      modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      type: z.enum(['down', 'up']),
      key: z.string().max(80),
      code: z.string().max(80),
      keyCode: z.number().int().min(0).max(255),
      modifiers,
    })
    .strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(65536) }).strict(),
  z
    .object({
      kind: z.literal('composition'),
      text: z.string().max(4096),
      selectionStart: z.number().int().min(0).max(4096),
      selectionEnd: z.number().int().min(0).max(4096),
    })
    .strict()
    .refine(event => event.selectionStart <= event.selectionEnd && event.selectionEnd <= event.text.length),
  z
    .object({ kind: z.literal('edit'), operation: z.enum(['undo', 'redo']) })
    .strict(),
  z
    .object({
      kind: z.literal('clipboard'),
      operation: z.enum(['copy', 'cut', 'paste', 'selectAll']),
    })
    .strict(),
]);

export const runtimeInput = z.union([
  runtimeEvent,
  z
    .object({
      kind: z.literal('batch'),
      events: z.array(runtimeEvent).min(1).max(32),
    })
    .strict()
    .refine(
      (batch) =>
        batch.events.every((event) => event.kind !== 'clipboard') &&
        batch.events.reduce(
          (size, event) =>
            size +
            (event.kind === 'text' || event.kind === 'composition'
              ? event.text.length
              : 0),
          0,
        ) <= 65536,
    ),
]);
