import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendResult,
  SessionChatMedia as MediaReply,
  SessionChatMediaRead,
  SessionChatItem,
} from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { SessionChatMedia } from "./session-chat-media";
import { chatExchanges } from "./session-chat-transcript";

const selection = { scopeId: "scope", taskId: 1, sessionId: 2 };
const items = (count: number): SessionChatItem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index),
    kind: "tool_result",
    text: "Image attachment",
    timestamp: "",
    toolId: null,
    toolName: null,
    toolKind: null,
    input: "",
    error: false,
    truncated: false,
    media: [
      { id: "0", path: `image-${index}`, caption: "Robot", inline: true },
    ],
  }));
afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup() {
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      naturalWidth = 640;
      naturalHeight = 360;
      decode = async () => undefined;
    },
  );
  const pending: {
    input: SessionChatMediaRead;
    resolve: (value: BackendResult<MediaReply>) => void;
  }[] = [];
  const client = {
    media: vi.fn(
      (_scope: string, input: SessionChatMediaRead) =>
        new Promise<BackendResult<MediaReply>>((resolve) =>
          pending.push({ input, resolve }),
        ),
    ),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      SessionChatMedia,
      { provide: SessionChatClient, useValue: client },
    ],
  });
  return { media: TestBed.inject(SessionChatMedia), client, pending };
}
describe("selected chat images", () => {
  it("keeps orphaned tool images on their receipt without an overflow button", () => {
    const [exchange] = chatExchanges(items(1), null, new Set());
    expect(exchange?.answer).toBe("");
    expect(exchange?.steps[0]?.media).toEqual([{ path: "image-0", caption: "Robot" }]);
    expect(exchange?.overflow).toEqual([]);
  });
  it("bounds concurrent reads and continues queued images across streaming updates", async () => {
    const { media, client, pending } = setup();
    media.update(selection, items(4));
    media.update(selection, items(5));
    expect(client.media).toHaveBeenCalledTimes(3);
    expect(media.resolve("image-0")).toMatchObject({ loading: true });
    expect(media.resolve("image-4")).toMatchObject({ kind: 'image', loading: true });
    pending[0]!.resolve({
      ok: true,
      value: {
        itemId: "0",
        mediaId: "0",
        source: "data:image/png;base64,AA==",
      },
    });
    await settle();
    expect(client.media).toHaveBeenCalledTimes(4);
    pending[1]!.resolve({
      ok: false,
      error: { code: "transport", message: "Offline" },
    });
    await settle();
    expect(client.media).toHaveBeenCalledTimes(5);
    expect(media.resolve("image-1")).toMatchObject({
      error: expect.stringContaining("Could not load"),
    });
  });
  it('reads viewed images on inspection and cancels an interrupted read without changing a shared-path attachment', async () => {
    const { media, client, pending } = setup();
    const attachment = items(1)[0]!;
    const call = { ...attachment, id: 'call', kind: 'tool_use' as const, toolId: 'view', toolKind: 'image_view', media: undefined };
    const result = { ...attachment, id: 'result', toolId: 'view' };
    const image = { itemId: result.id, mediaId: '0', path: 'image-0', caption: 'Screenshot' };
    media.update(selection, [attachment, call, result]);
    expect(pending.map(({ input }) => input.itemId)).toEqual([attachment.id]);
    const abort = new AbortController();
    const resolve = media.toolImages()!([image], abort.signal);
    expect(pending.map(({ input }) => input.itemId)).toEqual([attachment.id, result.id]);
    expect(resolve(image)).toMatchObject({ loading: true });
    abort.abort();
    expect(client.cancel).toHaveBeenCalledWith(selection.scopeId, pending[1]!.input.requestId);
    pending[1]!.resolve({ ok: true, value: { itemId: result.id, mediaId: '0', source: 'data:image/png;base64,AA==' } });
    await settle();
    expect(resolve(image)).toBeUndefined();
    expect(media.resolve(image.path)).toMatchObject({ loading: true });
    const reopened = media.toolImages()!([image], new AbortController().signal);
    pending[2]!.resolve({ ok: true, value: { itemId: result.id, mediaId: '0', source: 'data:image/png;base64,AQ==' } });
    await settle();
    expect(reopened(image)).toMatchObject({ src: 'data:image/png;base64,AQ==' });
  });
  it('uses the newest reference at a shared path and discards an evicted read', async () => {
    const { media, client, pending } = setup();
    const original = items(1)[0]!;
    const replacement = { ...original, id: 'new-receipt' };
    media.update(selection, [original]);
    media.update(selection, [original, replacement]);
    expect(client.cancel).toHaveBeenCalledWith(selection.scopeId, pending[0]!.input.requestId);
    expect(client.media).toHaveBeenCalledTimes(2);
    pending[0]!.resolve({
      ok: true, value: { itemId: original.id, mediaId: '0', source: 'data:image/png;base64,AA==' },
    });
    await settle();
    expect(media.resolve('image-0')).toMatchObject({ loading: true });
    pending[1]!.resolve({
      ok: true, value: { itemId: replacement.id, mediaId: '0', source: 'data:image/png;base64,AQ==' },
    });
    await settle();
    const asset = media.resolve('image-0');
    expect(asset).toMatchObject({ src: 'data:image/png;base64,AQ==' });
    media.update(selection, [original, { ...replacement, text: 'Streamed text' }]);
    expect(media.resolve('image-0')).toBe(asset);
    expect(client.media).toHaveBeenCalledTimes(2);
  });
  it("cancels selection-owned work and rejects late replies; destruction releases requests", async () => {
    const { media, client, pending } = setup();
    media.update(selection, items(1));
    media.update({ ...selection, sessionId: 3 }, []);
    expect(client.cancel).toHaveBeenCalledWith(
      "scope",
      pending[0]!.input.requestId,
    );
    pending[0]!.resolve({
      ok: true,
      value: {
        itemId: "0",
        mediaId: "0",
        source: "data:image/png;base64,AA==",
      },
    });
    await settle();
    expect(media.resolve("image-0")).toBeUndefined();
    media.update({ ...selection, sessionId: 3 }, items(1));
    TestBed.resetTestingModule();
    expect(client.cancel).toHaveBeenCalledTimes(2);
  });
});
