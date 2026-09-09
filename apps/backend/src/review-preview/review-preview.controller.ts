import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { buildPreviewBridgeScript } from './preview-bridge.js';
import {
  ReviewPreviewService,
  type PreviewAssetPath,
} from './review-preview.service.js';

interface CreatePreviewSessionBody {
  worktreePath: string;
  /**
   * Origin the frame will be loaded from, as the browser sees it. Declared by
   * the client because the backend cannot infer it behind the dev-server
   * proxy; see the note in ReviewPreviewService.
   */
  previewOrigin?: string;
}

/**
 * Routes for the review workspace's HTML preview.
 *
 * Note the declaration order: Nest registers routes as written, so the bridge
 * route has to come before the wildcard or the wildcard swallows it. The
 * service separately rejects any asset path beginning with the reserved
 * segment, so a real directory of that name cannot shadow it either.
 */
@Controller('review-preview')
export class ReviewPreviewController {
  constructor(private readonly reviewPreview: ReviewPreviewService) {}

  @Post('sessions')
  async createSession(
    @Body() body: CreatePreviewSessionBody,
    @Req() req: Request,
  ) {
    return this.reviewPreview.createSession(
      body?.worktreePath,
      body?.previewOrigin ?? originFromRequest(req),
    );
  }

  @Get('p/:previewId/___ex/bridge.js')
  bridge(
    @Param('previewId') previewId: string,
    @Res({ passthrough: true }) res: Response,
  ): string {
    // Validates the session so the bridge is not a public endpoint.
    this.reviewPreview.requireSession(previewId);
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return buildPreviewBridgeScript();
  }

  /**
   * The prefix on its own, which is what a link to `./` resolves to. Serves
   * the root index, mirroring how a static server behaves — the wildcard below
   * needs at least one segment and would otherwise 404 here.
   */
  @Get('p/:previewId')
  async root(
    @Param('previewId') previewId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.serve(previewId, [], res);
  }

  @Get('p/:previewId/*path')
  async asset(
    @Param('previewId') previewId: string,
    // Express 5 gives a `*path` wildcard as an array of decoded segments.
    @Param('path') assetPath: PreviewAssetPath,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.serve(previewId, assetPath, res);
  }

  private async serve(
    previewId: string,
    assetPath: PreviewAssetPath,
    res: Response,
  ): Promise<StreamableFile> {
    const asset = await this.reviewPreview.readAsset(previewId, assetPath);

    res.setHeader('Content-Type', asset.mimeType);
    // An agent may be editing the worktree mid-review, so a stale asset is
    // worse than re-reading from local disk.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (asset.contentSecurityPolicy) {
      res.setHeader('Content-Security-Policy', asset.contentSecurityPolicy);
    }

    // Split rather than passed straight through: StreamableFile's overloads
    // do not accept the Buffer|Readable union, only one or the other.
    return Buffer.isBuffer(asset.body)
      ? new StreamableFile(asset.body, { type: asset.mimeType })
      : new StreamableFile(asset.body, { type: asset.mimeType });
  }
}

/** Last-resort origin derivation, behind a proxy that sets forwarding headers. */
function originFromRequest(req: Request): string | null {
  const forwardedHost = headerValue(req, 'x-forwarded-host');
  if (forwardedHost) {
    const proto = headerValue(req, 'x-forwarded-proto') ?? 'http';
    return `${proto}://${forwardedHost}`;
  }
  const host = headerValue(req, 'host');
  return host ? `http://${host}` : null;
}

function headerValue(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value.split(',')[0].trim() || null : null;
}
