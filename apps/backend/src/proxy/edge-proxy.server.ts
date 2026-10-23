import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  Server as HttpServer,
  ServerResponse,
} from 'http';
import { request as httpsRequest } from 'https';
import { Socket } from 'net';
import { connect as tlsConnect } from 'tls';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Duplex } from 'stream';

interface FrontendProxyRule {
  target: string;
  ws?: boolean;
}

type FrontendProxyConfig = Record<string, FrontendProxyRule>;
type ProxyTargetMode = 'http' | 'ws';

interface EdgeProxyServerOptions {
  repoRoot: string;
  upstreamOrigin?: string;
  localHttpServer?: HttpServer;
}

function loadFrontendProxyConfig(repoRoot: string): FrontendProxyConfig {
  const configCandidates = [
    join(repoRoot, 'apps', 'frontend', 'proxy.conf.json'),
    join(repoRoot, 'proxy.conf.json'),
  ];

  const configPath = configCandidates.find((candidate) => {
    try {
      readFileSync(candidate, 'utf8');
      return true;
    } catch {
      return false;
    }
  });

  if (!configPath) {
    throw new Error(`Could not find proxy.conf.json under ${repoRoot}`);
  }

  return JSON.parse(readFileSync(configPath, 'utf8')) as FrontendProxyConfig;
}

function matchProxyRule(
  pathname: string,
  rules: FrontendProxyConfig,
): FrontendProxyRule | null {
  const sortedPrefixes = Object.keys(rules).sort(
    (left, right) => right.length - left.length,
  );

  for (const prefix of sortedPrefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return rules[prefix];
    }
  }

  return null;
}

function resolveProxyTarget(
  rule: FrontendProxyRule,
  upstreamOrigin: string | undefined,
  mode: ProxyTargetMode,
): URL {
  if (!upstreamOrigin) {
    const target = new URL(rule.target);
    if (mode === 'http' && target.protocol === 'ws:') {
      target.protocol = 'http:';
    } else if (mode === 'http' && target.protocol === 'wss:') {
      target.protocol = 'https:';
    } else if (mode === 'ws' && target.protocol === 'http:') {
      target.protocol = 'ws:';
    } else if (mode === 'ws' && target.protocol === 'https:') {
      target.protocol = 'wss:';
    }

    return target;
  }

  const target = new URL(upstreamOrigin);
  if (mode === 'ws' && target.protocol === 'http:') {
    target.protocol = 'ws:';
  } else if (mode === 'ws' && target.protocol === 'https:') {
    target.protocol = 'wss:';
  }

  return target;
}

function copyProxyHeaders(
  request: IncomingMessage,
  target: URL,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || key.toLowerCase() === 'host') {
      continue;
    }

    headers[key] = value;
  }

  headers.host = target.host;
  headers['x-forwarded-host'] = request.headers.host ?? '';
  headers['x-forwarded-proto'] = (request.socket as { encrypted?: boolean })
    .encrypted
    ? 'https'
    : 'http';

  return headers;
}

function writeProxyError(response: ServerResponse, error: Error): void {
  if (response.headersSent) {
    // Ending a partial chunked response would make truncated NDJSON look complete.
    response.destroy();
    return;
  }

  response.statusCode = 502;
  response.setHeader('Content-Type', 'application/json');
  response.end(
    JSON.stringify({
      message: 'Elevenex proxy request failed',
      error: error.message,
    }),
  );
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
): void {
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  let proxyResponse: IncomingMessage | undefined;
  let settled = false;

  const cleanup = () => {
    request.off('aborted', cancel);
    response.off('finish', onFinish);
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
    request.unpipe(proxyRequest);
    proxyResponse?.unpipe(response);
    proxyResponse?.destroy();
    proxyRequest.destroy();
  };
  const fail = (error: Error) => {
    if (settled) return;
    cancel();
    if (!response.destroyed && !response.writableEnded) {
      writeProxyError(response, error);
    }
  };
  const onFinish = () => {
    settled = true;
    cleanup();
  };

  const proxyRequest = transport(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: copyProxyHeaders(request, target),
    },
    (upstreamResponse) => {
      proxyResponse = upstreamResponse;
      const onAborted = () => fail(new Error('Upstream response aborted'));
      upstreamResponse.once('aborted', onAborted);
      upstreamResponse.on('error', fail);
      upstreamResponse.once('close', () => {
        if (!upstreamResponse.complete) onAborted();
        upstreamResponse.off('aborted', onAborted);
        upstreamResponse.off('error', fail);
      });
      if (settled) {
        upstreamResponse.destroy();
        return;
      }
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );

  // Keep error handlers through close: destroy() can emit a deferred ECONNRESET.
  proxyRequest.on('error', fail);
  proxyRequest.once('close', () => {
    if (!proxyResponse) fail(new Error('Upstream closed before responding'));
    proxyRequest.off('error', fail);
  });
  request.once('aborted', cancel);
  request.on('error', cancel);
  request.once('close', () => {
    // A completed upload normally closes while the response is still streaming.
    if (!request.complete) cancel();
    request.off('error', cancel);
  });
  response.once('close', () => {
    if (!response.writableFinished) cancel();
    response.off('error', cancel);
  });
  response.once('finish', onFinish);
  response.on('error', cancel);

  if (request.aborted || response.destroyed) cancel();
  else request.pipe(proxyRequest);
}

function serializeHeaders(
  headers: IncomingMessage['headers'],
  host: string,
): string {
  const lines: string[] = [];

  for (const [key, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || key.toLowerCase() === 'host') {
      continue;
    }

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push(`host: ${host}`);
  return lines.join('\r\n');
}

function createUpstreamSocket(target: URL): Socket {
  const port = target.port
    ? Number.parseInt(target.port, 10)
    : target.protocol === 'wss:'
      ? 443
      : 80;
  if (target.protocol === 'wss:' || target.protocol === 'https:') {
    return tlsConnect({
      host: target.hostname,
      port,
      servername: target.hostname,
    });
  }

  return new Socket().connect(port, target.hostname);
}

function proxyWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: URL,
): void {
  const upstreamSocket = createUpstreamSocket(target);
  const connectEvent =
    target.protocol === 'wss:' || target.protocol === 'https:'
      ? 'secureConnect'
      : 'connect';
  let connected = false;
  let stopped = false;

  const cleanup = () => {
    upstreamSocket.off(connectEvent, onConnect);
    socket.off('end', onClientEnd);
    socket.unpipe(upstreamSocket);
    upstreamSocket.unpipe(socket);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
    upstreamSocket.destroy();
    socket.destroy();
  };
  const finishPeer = (peer: Duplex) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    // A clean EOF can follow a WebSocket close frame. Flush piped bytes before
    // closing the peer so its close code/reason (or final data) is not lost.
    peer.end(() => peer.destroy());
  };
  const onClientEnd = () => {
    if (!connected) stop();
  };
  const onConnect = () => {
    if (stopped || socket.destroyed) {
      stop();
      return;
    }
    connected = true;
    const path = request.url || '/';
    const headerBlock = serializeHeaders(request.headers, target.host);
    upstreamSocket.write(
      `${request.method ?? 'GET'} ${path} HTTP/${request.httpVersion}\r\n${headerBlock}\r\n\r\n`,
    );

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  };

  const onUpstreamError = () => {
    if (stopped) return;
    if (connected || socket.destroyed) {
      stop();
      return;
    }
    stopped = true;
    cleanup();
    upstreamSocket.destroy();
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n', () => socket.destroy());
  };

  upstreamSocket.once(connectEvent, onConnect);
  upstreamSocket.on('error', onUpstreamError);
  socket.on('error', stop);
  socket.on('end', onClientEnd);
  upstreamSocket.once('close', () => {
    if (connected && upstreamSocket.readableEnded) finishPeer(socket);
    else stop();
    upstreamSocket.off('error', onUpstreamError);
  });
  socket.once('close', () => {
    if (connected && socket.readableEnded) finishPeer(upstreamSocket);
    else stop();
    socket.off('error', stop);
  });
  if (socket.destroyed) stop();
}

export function createEdgeProxyServer(
  options: EdgeProxyServerOptions,
): HttpServer {
  const proxyConfig = loadFrontendProxyConfig(options.repoRoot);
  const { upstreamOrigin, localHttpServer } = options;

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const matchedRule = matchProxyRule(pathname, proxyConfig);

    if (!matchedRule) {
      response.statusCode = 404;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ message: 'Route not exposed by Elevenex edge proxy' }),
      );
      return;
    }

    if (!upstreamOrigin && localHttpServer) {
      localHttpServer.emit('request', request, response);
    } else {
      const target = resolveProxyTarget(matchedRule, upstreamOrigin, 'http');
      proxyHttpRequest(request, response, target);
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const matchedRule = matchProxyRule(pathname, proxyConfig);

    if (!matchedRule?.ws) {
      socket.destroy();
      return;
    }

    if (!upstreamOrigin && localHttpServer) {
      localHttpServer.emit('upgrade', request, socket, head);
    } else {
      const target = resolveProxyTarget(matchedRule, upstreamOrigin, 'ws');
      proxyWebSocketUpgrade(request, socket, head, target);
    }
  });

  return server;
}
