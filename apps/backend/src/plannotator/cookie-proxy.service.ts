import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ProxyRewriteResult {
  proxyUrl: string;
  upstreamPort: number;
}

const COOKIE_FILE = path.join(os.homedir(), '.plannotator', 'app-cookies.json');

@Injectable()
export class CookieProxyService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger('CookieProxy');

  private upstreamCookies: Map<number, string> = new Map();
  private persistedCookies: string = '';

  constructor() {
    super();
    this.loadPersistedCookies();
  }

  private loadPersistedCookies(): void {
    try {
      if (fs.existsSync(COOKIE_FILE)) {
        const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
        this.persistedCookies = data.cookies || '';
      }
    } catch {
      this.persistedCookies = '';
    }
  }

  private savePersistedCookies(cookies: string): void {
    try {
      const dir = path.dirname(COOKIE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookies }));
      this.persistedCookies = cookies;
    } catch (err) {
      this.logger.warn(`Failed to persist cookies: ${err}`);
    }
  }

  /** Pre-populate cookies for a new upstream port from persisted storage */
  initUpstreamCookies(upstreamPort: number): void {
    if (!this.upstreamCookies.has(upstreamPort)) {
      this.loadPersistedCookies();
      if (this.persistedCookies) {
        this.upstreamCookies.set(upstreamPort, this.persistedCookies);
      }
    }
  }

  rewriteUrl(upstreamUrl: string): ProxyRewriteResult {
    const url = new URL(upstreamUrl);
    const upstreamPort = parseInt(url.port, 10);

    if (!upstreamPort) {
      throw new Error(`Invalid upstream URL: ${upstreamUrl}`);
    }

    const proxyUrl = `/api/plannotator/proxy/${upstreamPort}${url.pathname}${url.search}`;
    return { proxyUrl, upstreamPort };
  }

  handleProxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    upstreamPort: number,
    upstreamPath: string,
    search: string,
  ): void {
    const proxyUrl = `http://127.0.0.1:${upstreamPort}${upstreamPath}${search}`;

    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: `127.0.0.1:${upstreamPort}`,
      'accept-encoding': 'identity',
    };
    delete headers['cookie'];

    const savedCookies = this.upstreamCookies.get(upstreamPort) || '';
    if (savedCookies) {
      headers['cookie'] = savedCookies;
    }

    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      const MAX_RETRIES = 3;
      const BASE_DELAY = 200;

      const tryUpstreamRequest = (attempt: number): void => {
        const proxyReq = http.request(
          proxyUrl,
          { method: req.method, headers },
          (proxyRes) => {
            const contentType = proxyRes.headers['content-type'] || '';

            if (contentType.includes('text/html')) {
              const chunks: Buffer[] = [];
              proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
              proxyRes.on('end', () => {
                const html = Buffer.concat(chunks).toString('utf-8');

                // Parse Set-Cookie headers from upstream and merge into saved cookies
                const upstreamSetCookies = this.parseSetCookieHeaders(proxyRes.headers['set-cookie']);
                if (Object.keys(upstreamSetCookies).length > 0) {
                  const merged = { ...this.parseCookieString(savedCookies), ...upstreamSetCookies };
                  const mergedStr = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('; ');
                  this.upstreamCookies.set(upstreamPort, mergedStr);
                }

                const injected = this.injectScript(html, upstreamPort);
                const responseHeaders = { ...proxyRes.headers };
                delete responseHeaders['content-length'];
                delete responseHeaders['content-encoding'];
                delete responseHeaders['transfer-encoding'];
                delete responseHeaders['set-cookie'];

                res.writeHead(proxyRes.statusCode || 200, responseHeaders);
                res.end(injected);
              });
            } else {
              res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
              proxyRes.pipe(res);
            }
          },
        );

        proxyReq.on('error', (err) => {
          this.logger.warn(`Proxy request error (attempt ${attempt}): ${err.message}`);
          if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY * Math.pow(2, attempt);
            setTimeout(() => tryUpstreamRequest(attempt + 1), delay);
          } else {
            res.writeHead(502);
            res.end('Proxy error: upstream unavailable');
          }
        });

        proxyReq.end(body);
      };

      tryUpstreamRequest(0);
    });
  }

  handleSaveCookies(req: IncomingMessage, res: ServerResponse, upstreamPort: number): void {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      this.upstreamCookies.set(upstreamPort, body);
      this.savePersistedCookies(body);
      res.writeHead(200);
      res.end('ok');
    });
  }

  handleClose(req: IncomingMessage, res: ServerResponse, upstreamPort: number): void {
    this.emit('close', upstreamPort);
    res.writeHead(200);
    res.end('ok');
  }

  getCookies(upstreamPort: number): string {
    return this.upstreamCookies.get(upstreamPort) || '';
  }

  clearUpstream(upstreamPort: number): void {
    this.upstreamCookies.delete(upstreamPort);
  }

  private parseSetCookieHeaders(setCookieHeader: string | string[] | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!setCookieHeader) return cookies;
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const header of headers) {
      const parts = header.split(';');
      const nameValue = parts[0]?.trim();
      if (nameValue) {
        const eq = nameValue.indexOf('=');
        if (eq > 0) {
          cookies[nameValue.slice(0, eq)] = nameValue.slice(eq + 1);
        }
      }
    }
    return cookies;
  }

  private parseCookieString(str: string): Record<string, string> {
    const store: Record<string, string> = {};
    if (!str) return store;
    for (const c of str.split('; ')) {
      const eq = c.indexOf('=');
      if (eq > 0) store[c.slice(0, eq)] = c.slice(eq + 1);
    }
    return store;
  }

  private injectScript(html: string, upstreamPort: number): string {
    const initialCookies = JSON.stringify(this.parseCookieString(this.getCookies(upstreamPort)));
    const proxyBase = `/api/plannotator/proxy/${upstreamPort}`;
    const extBase = `/api/plannotator/___ext`;

    const rewritten = html.replace(
      /(\s(?:src|href|action)=["'])\/(?!\/|api\/plannotator\/)/g,
      `$1${proxyBase}/`,
    );

    const script = `<script>(function(){
      var P="${proxyBase}";
      var S=${initialCookies};S["plannotator-auto-close"]="true";
      Object.defineProperty(document,"cookie",{configurable:true,
        get:function(){return Object.keys(S).map(function(k){return k+"="+S[k]}).join("; ");},
        set:function(v){
          var p=v.split(";"),nv=p[0].trim(),eq=nv.indexOf("=");
          if(eq<1)return;
          var n=nv.slice(0,eq);
          if(/max-age\\s*=\\s*0/i.test(v)){delete S[n];}else{S[n]=nv.slice(eq+1);}
        }
      });
      function rw(u){if(typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf("/api/plannotator/")!==0)return P+u;return u;}
      var _fetch=window.fetch;
      window.fetch=function(r,o){
        if(typeof r==="string")r=rw(r);
        else if(r&&r.url)r=new Request(rw(r.url),r);
        return _fetch.call(this,r,o);
      };
      var _xhrOpen=XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open=function(m,u){
        arguments[1]=rw(u);
        return _xhrOpen.apply(this,arguments);
      };
      function sc(){var c=document.cookie;if(c)fetch("${extBase}/cookies?upstreamPort=${upstreamPort}",{method:"POST",body:c}).catch(function(){});}
      setTimeout(sc,500);setInterval(sc,2000);
      var ci=setInterval(function(){if(document.body&&document.body.textContent.indexOf("Your response has been sent")!==-1){clearInterval(ci);sc();fetch("${extBase}/close?upstreamPort=${upstreamPort}",{method:"POST",keepalive:true}).catch(function(){});}},500);
      window.close=function(){
        try{fetch("${extBase}/close?upstreamPort=${upstreamPort}",{method:"POST",keepalive:true}).catch(function(){});}catch(e){}
        try{window.parent.postMessage("plannotator-close","*");}catch(e){}
      };
      try{window.parent.postMessage("plannotator-ready","*");}catch(e){}
    })();</script>`;

    const headMatch = rewritten.match(/<head(\s[^>]*)?>/);
    if (headMatch) {
      const idx = rewritten.indexOf(headMatch[0]) + headMatch[0].length;
      return rewritten.slice(0, idx) + script + rewritten.slice(idx);
    }
    return script + rewritten;
  }

  onModuleDestroy() {
    this.upstreamCookies.clear();
  }
}
