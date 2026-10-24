import express from 'express';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

/** Hash once at startup, asynchronously. Runtime upgrades get distinct URLs
 * even when a distributor republishes the same package version. */
export async function resolveVSCodeAssetVersion(root: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for (const file of [
      'package.json',
      'out/vs/workbench/workbench.web.main.js',
      'out/vs/workbench/workbench.web.main.css',
    ]) {
      for await (const chunk of createReadStream(path.join(root, file)))
        hash.update(chunk);
    }
    return hash.digest('hex').slice(0, 20);
  } catch {
    return 'unavailable';
  }
}

export function vscodeStatic(
  root: string,
  immutable = false,
): express.RequestHandler {
  const options = { maxAge: immutable ? '1y' : 0, immutable };
  const raw = express.static(root, options);
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.vary('Accept-Encoding');
    try {
      const relative = decodeURIComponent(req.path);
      const file = path.resolve(root, `.${relative}`);
      if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) return next();
      const encoding = req.acceptsEncodings('br', 'gzip', 'identity');
      const suffix =
        encoding === 'br' ? '.br' : encoding === 'gzip' ? '.gz' : '';
      if (suffix && (await stat(file + suffix).catch(() => null))?.isFile()) {
        res.type(file);
        res.setHeader('Content-Encoding', encoding as string);
        res.sendFile(file + suffix, options, (error) => {
          if (error && !res.headersSent) next(error);
        });
        return;
      }
      raw(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
