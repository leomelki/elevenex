'use strict';

// HTTP helpers shared by the runtime installer and the desktop app updater.
// Deliberately built on node:http/node:https rather than Electron's `net`
// module so this file stays requirable from plain Node (tests, scripts) and
// keeps the exact redirect/progress semantics the runtime installer already
// relied on.

const { createHash } = require('crypto');
const { createReadStream, createWriteStream, mkdirSync, rmSync } = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const MAX_DOWNLOAD_REDIRECTS = 5;
const PROGRESS_THROTTLE_MS = 150;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_TEXT_RESPONSE_BYTES = 8 * 1024 * 1024;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRedirect(response) {
  return response.statusCode >= 300
    && response.statusCode < 400
    && Boolean(response.headers.location);
}

// GitHub redirects release downloads to a pre-signed objects.githubusercontent.com
// URL. Forwarding our Authorization header there both leaks the token to another
// host and makes the signed request fail, so credentials are dropped whenever the
// origin changes.
function nextRequestOptions(fromUrl, toUrl, options) {
  if (!options.headers) {
    return options;
  }

  const sameOrigin = new URL(fromUrl).host === new URL(toUrl).host;
  if (sameOrigin) {
    return options;
  }

  const headers = { ...options.headers };
  delete headers.Authorization;
  delete headers.authorization;
  return { ...options, headers };
}

function requestGet(url, options, onResponse, onError) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    onError(new Error(`Unsupported URL protocol: ${target.protocol}`));
    return null;
  }

  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...requestOptions } = options;
  const get = target.protocol === 'https:' ? https.get : http.get;
  const request = get(url, requestOptions, onResponse);

  request.setTimeout(timeoutMs, () => {
    request.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
  });
  request.on('error', onError);

  return request;
}

/**
 * Stream `url` to `destinationPath`, following redirects and reporting throttled
 * progress. The partial file is removed on any failure so callers never observe
 * a truncated download.
 */
function downloadToFile(url, destinationPath, onProgress, options = {}, _redirectCount = 0) {
  if (_redirectCount > MAX_DOWNLOAD_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    const file = createWriteStream(destinationPath);
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      file.close(() => {
        rmSync(destinationPath, { force: true });
        reject(error);
      });
    };

    requestGet(url, options, (response) => {
      if (isRedirect(response)) {
        const redirectUrl = new URL(response.headers.location, url).toString();
        response.resume();
        file.close();
        rmSync(destinationPath, { force: true });
        downloadToFile(
          redirectUrl,
          destinationPath,
          onProgress,
          nextRequestOptions(url, redirectUrl, options),
          _redirectCount + 1,
        ).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Download failed (HTTP ${response.statusCode}): ${url}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let receivedBytes = 0;
      let lastProgressAt = 0;

      if (onProgress && totalBytes > 0) {
        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_THROTTLE_MS || receivedBytes >= totalBytes) {
            lastProgressAt = now;
            onProgress(receivedBytes, totalBytes);
          }
        });
      }

      response.on('error', fail);
      response.pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(() => resolve({ totalBytes: totalBytes || receivedBytes }));
      });
      file.on('error', fail);
    }, fail);
  });
}

/** Fetch a small text resource (release metadata, checksum sidecars). */
function fetchText(url, options = {}, _redirectCount = 0) {
  if (_redirectCount > MAX_DOWNLOAD_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects fetching ${url}`));
  }

  return new Promise((resolve, reject) => {
    requestGet(url, options, (response) => {
      if (isRedirect(response)) {
        const redirectUrl = new URL(response.headers.location, url).toString();
        response.resume();
        fetchText(
          redirectUrl,
          nextRequestOptions(url, redirectUrl, options),
          _redirectCount + 1,
        ).then(resolve, reject);
        return;
      }

      const chunks = [];
      let size = 0;

      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_TEXT_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error(`Response too large: ${url}`));
          return;
        }
        chunks.push(chunk);
      });

      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(Object.assign(
            new Error(`Request failed (HTTP ${response.statusCode}): ${url}`),
            { statusCode: response.statusCode, body },
          ));
          return;
        }
        resolve(body);
      });
    }, reject);
  });
}

async function fetchJson(url, options = {}) {
  const body = await fetchText(url, options);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Malformed JSON response from ${url}`);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Parse a `sha256sum`/`shasum -a 256` style sidecar: "<hex>  <filename>". */
function parseChecksumFile(contents) {
  const match = /\b([a-f0-9]{64})\b/i.exec(String(contents ?? ''));
  return match ? match[1].toLowerCase() : null;
}

module.exports = {
  MAX_DOWNLOAD_REDIRECTS,
  downloadToFile,
  fetchJson,
  fetchText,
  formatBytes,
  parseChecksumFile,
  sha256File,
};
