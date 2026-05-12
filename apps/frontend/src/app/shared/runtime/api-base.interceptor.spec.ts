import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideApiBaseInterceptor } from './api-base.interceptor';
import { ServerConnectionService } from '../services/server-connection.service';

describe('apiBaseInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let resolveGate: (() => void) | null = null;
  const serverConnectionMock = {
    waitUntilInteractive: vi.fn(() => new Promise<void>((resolve) => {
      resolveGate = resolve;
    })),
  };

  beforeEach(() => {
    resolveGate = null;
    vi.clearAllMocks();
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://backend.test' };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(provideApiBaseInterceptor()),
        provideHttpClientTesting(),
        { provide: ServerConnectionService, useValue: serverConnectionMock },
      ],
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    window.__ELEVENEX_RUNTIME__ = undefined;
  });

  it('waits for server interactivity before sending relative backend requests', async () => {
    const response = vi.fn();
    http.get('/api/info').subscribe(response);

    expect(serverConnectionMock.waitUntilInteractive).toHaveBeenCalledTimes(1);
    httpMock.expectNone('http://backend.test/api/info');

    resolveGate?.();
    await Promise.resolve();

    const request = httpMock.expectOne('http://backend.test/api/info');
    request.flush({ backendSha: 'abc123' });

    expect(response).toHaveBeenCalledWith({ backendSha: 'abc123' });
  });

  it('waits for server interactivity before sending absolute backend requests', async () => {
    const response = vi.fn();
    http.get('http://backend.test/vscode-static/index.html', { responseType: 'text' }).subscribe(response);

    httpMock.expectNone('http://backend.test/vscode-static/index.html');
    resolveGate?.();
    await Promise.resolve();

    const request = httpMock.expectOne('http://backend.test/vscode-static/index.html');
    request.flush('<html></html>');

    expect(response).toHaveBeenCalledWith('<html></html>');
  });

  it('does not gate absolute external URLs', () => {
    const response = vi.fn();
    http.get('https://example.com/data').subscribe(response);

    const request = httpMock.expectOne('https://example.com/data');
    request.flush({ ok: true });

    expect(serverConnectionMock.waitUntilInteractive).not.toHaveBeenCalled();
    expect(response).toHaveBeenCalledWith({ ok: true });
  });
});
