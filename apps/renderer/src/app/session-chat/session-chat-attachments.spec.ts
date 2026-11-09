import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { SessionChatDrafts } from "./session-chat-drafts";
import { SessionChatAttachments } from "./session-chat-attachments";
import type {
  BackendResult,
  ChatAttachmentReceipt,
  ChatAttachmentUpload,
} from "@elevenex/shared";
const selection = { scopeId: "scope", taskId: 1, sessionId: 2 };
afterEach(() => TestBed.resetTestingModule());
function setup(
  impl?: (
    input: ChatAttachmentUpload,
  ) => Promise<BackendResult<ChatAttachmentReceipt>>,
) {
  const upload = vi.fn((_scope: string, input: ChatAttachmentUpload) =>
    impl
      ? impl(input)
      : Promise.resolve({
          ok: true as const,
          value: {
            id: input.id,
            offset: input.size,
            path: "/stored/" + input.name,
          },
        }),
  );
  const cancel = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      SessionChatDrafts,
      SessionChatAttachments,
      { provide: SessionChatClient, useValue: { upload, cancel } },
    ],
  });
  const owner = TestBed.inject(SessionChatAttachments);
  owner.open(selection);
  return { owner, upload, cancel, drafts: TestBed.inject(SessionChatDrafts) };
}
describe("selected file uploads", () => {
  it("retains completed files across session navigation and avoids duplicate selections", async () => {
    const { owner, upload } = setup();
    const file = new File(["notes"], "notes.txt");
    owner.add([file, file]);
    await vi.waitFor(() => expect(owner.files()[0]?.status).toBe("ready"));
    expect(upload).toHaveBeenCalledTimes(1);
    owner.open({ ...selection, sessionId: 3 });
    expect(owner.files()).toEqual([]);
    owner.open(selection);
    expect(owner.files()[0]?.name).toBe("notes.txt");
  });
  it("cancels selected-session work and rejects late upload receipts", async () => {
    let reply!: (value: BackendResult<ChatAttachmentReceipt>) => void;
    const { owner, upload, cancel, drafts } = setup(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    owner.add([new File(["notes"], "notes.txt")]);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const id = owner.files()[0]!.id;
    owner.open({ ...selection, sessionId: 3 });
    expect(cancel).toHaveBeenCalledTimes(1);
    reply({ ok: true, value: { id, offset: 5, path: "/late" } });
    await Promise.resolve();
    expect(owner.files()).toEqual([]);
    expect(drafts.entry("scope", 2).files()[0]?.status).toBe("error");
  });
  it("keeps failed files for explicit retry and rejects excessive selections", async () => {
    const { owner, upload } = setup();
    upload.mockResolvedValueOnce({
      ok: false,
      error: { code: "transport", message: "offline" },
    });
    owner.add([new File(["notes"], "notes.txt")]);
    await vi.waitFor(() => expect(owner.files()[0]?.status).toBe("error"));
    owner.retry(owner.files()[0]!.id);
    await vi.waitFor(() => expect(owner.files()[0]?.status).toBe("ready"));
    owner.add(
      Array.from({ length: 9 }, (_, i) => new File(["x"], `file${i}.txt`)),
    );
    expect(owner.files()).toHaveLength(8);
    expect(owner.error()).toContain("8 files");
  });
});

describe('browser element attachments', () => {
  const snapshot = { reference: { version: 1 as const, id: '11111111-1111-4111-8111-111111111111', label: 'button · Save', tag: 'button', selector: 'button', frames: [], page: 'https://example.com/checkout', tabId: 'tab-1', documentId: 'document-1', capturedAt: '2026-11-09T10:00:00Z', target: { x: 20, y: 30, width: 80, height: 30 }, crop: { x: 0, y: 0, width: 148, height: 108 }, image: { width: 148, height: 108, scale: 1 } }, jpeg: '/9j/' };
  it('deduplicates stable references and retains image association across retry and navigation', async () => {
    let reject = true;
    const { owner, upload } = setup(input => Promise.resolve(reject ? { ok: false, error: { code: 'transport', message: 'offline' } } : { ok: true, value: { id: input.id, offset: input.size, path: '/stored/' + input.name } }));
    expect(owner.addElement(snapshot)).toBe(1); expect(owner.addElement(snapshot)).toBe(1);
    await vi.waitFor(() => expect(owner.files()[0]?.status).toBe('error'));
    expect(owner.files()).toHaveLength(1);
    reject = false;
    owner.retry(owner.files()[0]!.id);
    await vi.waitFor(() => expect(owner.files()[0]?.status).toBe('ready'));
    expect(owner.files()[0]?.element?.id).toBe(snapshot.reference.id);
    expect(owner.files()[0]?.marker).toBe(1);
    expect(upload).toHaveBeenCalledTimes(2);
    owner.open({ ...selection, sessionId: 3 }); expect(owner.files()).toHaveLength(0);
    owner.open(selection); expect(owner.files()[0]?.element).toEqual(snapshot.reference);
    owner.remove(owner.files()[0]!.id); expect(owner.files()).toHaveLength(0);
  });
  it('gives each element the lowest free pin, never reusing one still on the draft', () => {
    const { owner } = setup(input => Promise.resolve({ ok: true, value: { id: input.id, offset: input.size, path: '/stored/' + input.name } }));
    const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    expect(owner.addElement(snapshot)).toBe(1);
    expect(owner.addElement({ ...snapshot, reference: { ...snapshot.reference, id: ids[0]! } })).toBe(2);
    owner.remove(owner.files()[0]!.id);
    expect(owner.addElement({ ...snapshot, reference: { ...snapshot.reference, id: ids[1]! } })).toBe(1);
    expect(owner.files().map(file => file.marker)).toEqual([2, 1]);
  });
  it('does not create a pretend image on capture failure', () => {
    const { owner, upload } = setup(); expect(owner.addElement({ reference: snapshot.reference, error: 'Page changed' })).toBeNull();
    expect(owner.files()).toHaveLength(0); expect(upload).not.toHaveBeenCalled(); expect(owner.error()).toBe('Page changed');
  });
});
