/**
 * The preview bridge protocol.
 *
 * Mirrored by hand in
 * `apps/frontend/src/app/shared/models/review-preview-bridge.model.ts`, which
 * is the source of truth — keep the two in step. There is no shared package in
 * this workspace, and creating one for a hundred lines of types would cost
 * more than it saves.
 */

export const PREVIEW_BRIDGE_CHANNEL = 'elevenex-preview';
export const PREVIEW_BRIDGE_VERSION = 1;

/**
 * Where a selection came from.
 *
 * `lines` is what an instrumented worktree file produces. `dom` is the
 * fallback for anything with no source mapping — script-generated markup
 * today, and a proxied dev-server page later, which is why the union exists
 * before there is a second producer.
 */
export type PreviewSourceRef =
  | {
      kind: 'lines';
      path: string;
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

export interface PreviewSessionDescriptor {
  previewId: string;
  /** Absolute URL prefix every preview document and asset is served under. */
  urlPrefix: string;
}
