/**
 * The preview bridge protocol.
 *
 * This file is the source of truth; `apps/backend/src/review-preview/
 * review-preview.types.ts` mirrors the shared parts and the bridge script
 * itself speaks it. Keep the three in step — there is no shared package in
 * this workspace, and adding one for a hundred lines of types would cost more
 * than it saves.
 *
 * The frame is sandboxed without `allow-same-origin`, which has two
 * consequences the protocol has to be designed around rather than discover:
 * messages from it arrive with `event.origin === 'null'`, and messages sent to
 * it are only delivered with a `targetOrigin` of `'*'`. The parent therefore
 * authenticates by frame identity (`event.source`) plus the preview id, which
 * is a 128-bit secret any embedder had to know to build the frame URL at all.
 */

export const PREVIEW_BRIDGE_CHANNEL = 'elevenex-preview';
export const PREVIEW_BRIDGE_VERSION = 1;

/**
 * Where a selection came from.
 *
 * `lines` is what an instrumented worktree file produces. `dom` covers
 * everything else — script-generated markup today, a proxied dev-server page
 * later. Consumers branch on `kind`, never on "is this a file", which is what
 * lets a URL target reuse all of this untouched.
 */
export type PreviewSourceRef =
  | {
      kind: 'lines';
      /** Worktree-relative path, or null for a target with no file. */
      path: string | null;
      startLine: number;
      endLine: number;
    }
  | {
      kind: 'dom';
      path: string | null;
      nodePath: string;
      nodeId: number | null;
      tagName: string;
    };

export interface PreviewRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Colours handed to the frame, which cannot read the app's CSS variables. */
export interface PreviewTheme {
  anchor: string;
  anchorBorder: string;
}

/** A discussion anchor to paint into the rendered page. */
export interface PreviewAnchorHighlight {
  chatId: number;
  source: PreviewSourceRef;
  title?: string;
}

export type PreviewInboundMessage =
  | { type: 'ready'; path: string | null; instrumented: boolean; contentHeight: number; title: string | null }
  | { type: 'selection-changed'; text: string; rect: PreviewRect; source: PreviewSourceRef | null }
  | { type: 'selection-cleared' }
  | { type: 'navigate'; href: string; path: string | null; external: boolean }
  | { type: 'scroll'; top: number }
  | { type: 'resize'; contentHeight: number }
  | { type: 'anchor-click'; chatId: number }
  | { type: 'error'; message: string };

export type PreviewOutboundMessage =
  | { type: 'init'; features: readonly string[]; theme: PreviewTheme }
  | { type: 'scroll-to'; top: number }
  | { type: 'clear-selection' }
  | { type: 'reload' }
  | { type: 'highlight'; anchors: readonly PreviewAnchorHighlight[] };

interface PreviewEnvelope {
  ex: typeof PREVIEW_BRIDGE_CHANNEL;
  v: typeof PREVIEW_BRIDGE_VERSION;
  previewId: string;
}

export type PreviewInboundEnvelope = PreviewEnvelope & PreviewInboundMessage;
export type PreviewOutboundEnvelope = PreviewEnvelope & PreviewOutboundMessage;

/**
 * Whether a `message` event is one of ours, from the frame we expect.
 *
 * Note there is no origin comparison, and that is deliberate: an opaque origin
 * matches no concrete origin string, so any such check would reject every
 * legitimate message. Frame identity plus the preview id is the stronger test
 * anyway — `event.source` cannot be forged by another frame.
 */
export function isPreviewMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
  previewId: string,
): event is MessageEvent<PreviewInboundEnvelope> {
  if (!frame || event.source !== frame.contentWindow) return false;
  const data = event.data as Partial<PreviewInboundEnvelope> | null;
  return (
    !!data &&
    data.ex === PREVIEW_BRIDGE_CHANNEL &&
    data.v === PREVIEW_BRIDGE_VERSION &&
    data.previewId === previewId
  );
}
