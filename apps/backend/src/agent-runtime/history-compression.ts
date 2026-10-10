import compression from 'compression';
import type { RequestHandler } from 'express';
import { constants } from 'node:zlib';

const HISTORY_PATH = /^\/api\/sessions\/\d+\/agents\/[^/]+\/(?:history|snapshot|subagents\/[^/]+\/history)(?:\?|$)/;

/** Compress transcript responses before they cross SSH or the paired TCP tunnel. */
export function createHistoryCompression(): RequestHandler {
  return compression({
    threshold: 2048,
    // Streaming zlib runs off the main thread. Favor latency over maximum ratio.
    level: constants.Z_BEST_SPEED,
    filter: (req, res) => HISTORY_PATH.test(req.originalUrl) && compression.filter(req, res),
  });
}
