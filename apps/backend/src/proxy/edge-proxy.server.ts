import { createServer, IncomingMessage, request as httpRequest, Server as HttpServer, ServerResponse } from 'http';
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

function matchProxyRule(pathname: string, rules: FrontendProxyConfig): FrontendProxyRule | null {
  const sortedPrefixes = Object.keys(rules).sort((left, right) => right.length - left.length);

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

function copyProxyHeaders(request: IncomingMessage, target: URL): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || key.toLowerCase() === 'host') {
      continue;
    }

    headers[key] = value;
  }

  headers.host = target.host;
  headers['x-forwarded-host'] = request.headers.host ?? '';
  headers['x-forwarded-proto'] = (request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';

  return headers;
}

function writeProxyError(response: ServerResponse, error: Error): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.statusCode = 502;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({
    message: 'Elevenex proxy request failed',
    error: error.message,
  }));
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
): void {
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const proxyRequest = transport(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: copyProxyHeaders(request, target),
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    },
  );

  proxyRequest.on('error', (error) => {
    writeProxyError(response, error);
  });

  request.pipe(proxyRequest);
}

function serializeHeaders(headers: IncomingMessage['headers'], host: string): string {
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
  const port = target.port ? Number.parseInt(target.port, 10) : target.protocol === 'wss:' ? 443 : 80;
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

  upstreamSocket.on('connect', () => {
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
  });

  upstreamSocket.on('error', () => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  });

  socket.on('error', () => {
    upstreamSocket.destroy();
  });
}

export function createEdgeProxyServer(options: EdgeProxyServerOptions): HttpServer {
  const proxyConfig = loadFrontendProxyConfig(options.repoRoot);
  const { upstreamOrigin, localHttpServer } = options;

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const matchedRule = matchProxyRule(pathname, proxyConfig);

    if (!matchedRule) {
      response.statusCode = 404;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ message: 'Route not exposed by Elevenex edge proxy' }));
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
