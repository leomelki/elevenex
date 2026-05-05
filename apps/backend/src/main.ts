import { interceptProcessStreams } from './backend-logs/log-interceptor.js';
interceptProcessStreams();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { TerminalGateway } from './terminal/terminal.gateway.js';
import { UserTerminalGateway } from './user-terminal/user-terminal.gateway.js';
import { ActionsGateway } from './actions/actions.gateway.js';
import { FileChangeGateway } from './file-watcher/file-change.gateway.js';
import { ClaudeHooksGateway } from './claude-hooks/claude-hooks.gateway.js';
import { ClaudeRuntimeGateway } from './claude-runtime/claude-runtime.gateway.js';
import { BackendLogsGateway } from './backend-logs/backend-logs.gateway.js';
import { CookieProxyService } from './plannotator/cookie-proxy.service.js';
import { join } from 'path';
import * as http from 'http';
import * as express from 'express';
import { createEdgeProxyServer } from './proxy/edge-proxy.server.js';
import {
  getEdgeProxyUpstreamOrigin,
  getElevenexProxyPort,
} from './config/ports.js';
import { readFile } from 'fs/promises';
import {
  getBackendRuntimeRoot,
  getBackendVSCodeStaticPath,
} from './config/runtime-paths.js';
import {
  buildVSCodeWebLauncherHtml,
  renderVSCodeWorkbenchHtml,
} from './config/vscode-web-launcher.js';
import {
  buildMcpAuthProxyUnavailableHtml,
  parseMcpAuthProxyRequestUrl,
  rewriteMcpAuthLocationHeader,
} from './proxy/mcp-auth-proxy.js';

function listenServer(
  server: {
    listen: (port: number, host: string, cb: () => void) => void;
    once: (event: 'error', cb: (error: Error) => void) => void;
  },
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  const runtimeRoot = getBackendRuntimeRoot();

  // Serve a stable launcher in both dev and packaged modes.
  app.use('/vscode-static/index.html', (_req: express.Request, res: express.Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buildVSCodeWebLauncherHtml());
  });

  const vscodeStaticPath = getBackendVSCodeStaticPath();

  // workbench.html ships with {{WORKBENCH_WEB_BASE_URL}}-style placeholders
  // that VS Code's own server would substitute. Render it ourselves and inject
  // window.product from the iframe query string so asset URLs resolve and the
  // workspace/extensions load.
  const renderWorkbench = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    sourcePath: string,
  ) => {
    try {
      const raw = await readFile(sourcePath, 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(renderVSCodeWorkbenchHtml(raw));
    } catch (error) {
      next(error);
    }
  };

  app.use(
    '/vscode-static/out/vs/code/browser/workbench/workbench.html',
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      renderWorkbench(
        req,
        res,
        next,
        join(vscodeStaticPath, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'),
      );
    },
  );

  app.use(
    '/vscode-static/out/vs/code/browser/workbench/workbench-dev.html',
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      renderWorkbench(
        req,
        res,
        next,
        join(vscodeStaticPath, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench-dev.html'),
      );
    },
  );

  app.use('/vscode-static', express.static(vscodeStaticPath, {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));

  // Serve FileSystemProvider extension bundle
  const ext1Path = join(runtimeRoot, 'vscode-filesystem-provider');
  app.use('/vscode-ext1', express.static(ext1Path));

  // Serve SCM extension bundle
  const ext2Path = join(runtimeRoot, 'vscode-scm-extension');
  app.use('/vscode-ext2', express.static(ext2Path));

  // Register MCP auth proxy BEFORE body-parser so req stream is readable
  // Proxies localhost MCP auth servers for SSH/remote access: /api/mcp-auth-proxy/:port/*
  app.use('/api/mcp-auth-proxy', (req: any, res: any) => {
    const parsedProxyUrl = parseMcpAuthProxyRequestUrl(req.url as string);
    if (!parsedProxyUrl) { res.writeHead(404); res.end('Invalid proxy path'); return; }
    const { port, upstreamPath } = parsedProxyUrl;
    const proxyReq = http.request(
      { hostname: '127.0.0.1', port, path: upstreamPath, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        if (typeof headers.location === 'string') {
          headers.location = rewriteMcpAuthLocationHeader(headers.location, port, upstreamPath);
        }
        res.writeHead(proxyRes.statusCode || 200, headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildMcpAuthProxyUnavailableHtml(port));
      }
    });
    req.pipe(proxyReq);
  });

  // Register plannotator proxy routes BEFORE body-parser so req stream is readable
  const cookieProxy = app.get(CookieProxyService);

  app.use('/api/plannotator/proxy', (req: any, res: any) => {
    const match = req.url.match(/^\/(\d+)(\/.*)?$/);
    if (!match) { res.writeHead(404); res.end('Invalid proxy path'); return; }
    const upstreamPort = parseInt(match[1], 10);
    const upstreamPath = match[2] || '/';
    const parsedUrl = new URL(req.originalUrl, 'http://localhost');
    cookieProxy.handleProxyRequest(req, res, upstreamPort, upstreamPath, parsedUrl.search);
  });

  app.use('/api/plannotator/___ext/cookies', (req: any, res: any) => {
    const parsedUrl = new URL(req.originalUrl, 'http://localhost');
    const upstreamPort = parseInt(parsedUrl.searchParams.get('upstreamPort') || '0', 10);
    if (!upstreamPort) { res.writeHead(400); res.end('Missing upstreamPort'); return; }
    cookieProxy.handleSaveCookies(req, res, upstreamPort);
  });

  app.use('/api/plannotator/___ext/close', (req: any, res: any) => {
    const parsedUrl = new URL(req.originalUrl, 'http://localhost');
    const upstreamPort = parseInt(parsedUrl.searchParams.get('upstreamPort') || '0', 10);
    if (!upstreamPort) { res.writeHead(400); res.end('Missing upstreamPort'); return; }
    cookieProxy.handleClose(req, res, upstreamPort);
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors();

  const httpServer = app.getHttpServer();

  const terminalGateway = app.get(TerminalGateway);
  terminalGateway.attachToServer(httpServer);

  const userTerminalGateway = app.get(UserTerminalGateway);
  userTerminalGateway.attachToServer(httpServer);

  const actionsGateway = app.get(ActionsGateway);
  actionsGateway.attachToServer(httpServer);

  const fileChangeGateway = app.get(FileChangeGateway);
  fileChangeGateway.attachToServer(httpServer);

  const claudeHooksGateway = app.get(ClaudeHooksGateway);
  claudeHooksGateway.attachToServer(httpServer);

  const claudeRuntimeGateway = app.get(ClaudeRuntimeGateway);
  claudeRuntimeGateway.attachToServer(httpServer);

  const backendLogsGateway = app.get(BackendLogsGateway);
  backendLogsGateway.attachToServer(httpServer);

  await app.init();

  const edgeProxyServer = createEdgeProxyServer({
    repoRoot: runtimeRoot,
    upstreamOrigin: getEdgeProxyUpstreamOrigin(),
    localHttpServer: httpServer,
  });
  await listenServer(edgeProxyServer, getElevenexProxyPort(), '0.0.0.0');
}
bootstrap();
