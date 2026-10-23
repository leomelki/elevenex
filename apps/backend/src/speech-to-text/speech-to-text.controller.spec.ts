import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { Logger } from '@nestjs/common';
import { SpeechToTextController } from './speech-to-text.controller.js';
import { SpeechToTextService } from './speech-to-text.service.js';
import { SPEECH_TO_TEXT_TIMEOUT_MS } from './speech-to-text.types.js';

const originalFetch = global.fetch;

function request(body: unknown = Buffer.from('audio')) {
  return Object.assign(new EventEmitter(), {
    body,
    headers: { 'content-type': 'audio/wav' },
    aborted: false,
  }) as unknown as Request;
}

function response() {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as unknown as Response;
}

function createService() {
  const settings = {
    getSpeechToTextConfig: jest.fn(async () => ({
      enabled: true,
      provider: 'openai-compatible',
      apiKey: 'secret-key',
      baseUrl: 'https://example.test/v1',
      model: 'whisper-1',
      languages: [],
      keytermsEnabled: false,
      cleanupMode: 'off',
    })),
  };
  return new SpeechToTextService(
    null as never,
    settings as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('SpeechToTextController request cancellation', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['transcribe', 'test'] as const)(
    'aborts %s on response disconnect and releases all request listeners',
    async (route) => {
      const service = createService();
      const controller = new SpeechToTextController(service);
      const req = request();
      const res = response();
      let providerSignal!: AbortSignal;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      global.fetch = jest.fn((_url, init) => {
        providerSignal = init!.signal as AbortSignal;
        started();
        return new Promise(() => undefined);
      }) as never;
      const result = controller[route](req, {}, res);
      const failure = expect(result).rejects.toMatchObject({ status: 499 });
      await ready;
      // IncomingMessage.close is normal once the raw upload is fully received.
      req.emit('close');
      expect(providerSignal.aborted).toBe(false);
      res.emit('close');
      await failure;
      expect(providerSignal.aborted).toBe(true);
      expect(req.listenerCount('aborted')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
    },
  );

  it('propagates an aborted request during preparation and never starts fetch', async () => {
    const service = createService();
    const controller = new SpeechToTextController(service);
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    const req = request();
    const res = response();
    const result = controller.transcribe(req, {}, res);
    req.emit('aborted');
    await expect(result).rejects.toMatchObject({ status: 499 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('rejects an already disconnected client before preparation', async () => {
    const service = createService();
    const transcribe = jest.spyOn(service, 'transcribe');
    const req = request();
    const res = response();
    req.aborted = true;
    const controller = new SpeechToTextController(service);
    await expect(controller.transcribe(req, {}, res)).rejects.toMatchObject({
      status: 499,
    });
    expect(transcribe.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('returns HTTP 504 on deadline, never reports success, and releases listeners', async () => {
    jest.useFakeTimers();
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const controller = new SpeechToTextController(createService());
    const req = request();
    const res = response();
    global.fetch = jest.fn(() => new Promise(() => undefined)) as never;
    const result = controller.transcribe(req, {}, res);
    const failure = expect(result).rejects.toMatchObject({ status: 504 });
    await jest.advanceTimersByTimeAsync(SPEECH_TO_TEXT_TIMEOUT_MS);
    await failure;
    expect(log).not.toHaveBeenCalled();
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['success', 'provider-error', 'invalid-body'])(
    'cleans up on %s and preserves existing listeners',
    async (outcome) => {
      const controller = new SpeechToTextController(createService());
      const req = request(
        outcome === 'invalid-body' ? {} : Buffer.from('audio'),
      );
      const res = response();
      const existing = jest.fn();
      req.on('aborted', existing);
      res.on('close', existing);
      global.fetch = jest.fn(async () => ({
        ok: outcome !== 'provider-error',
        status: 401,
        json: async () => ({ text: 'hello' }),
      })) as never;
      const result = controller.transcribe(req, {}, res);
      if (outcome === 'success')
        await expect(result).resolves.toMatchObject({ text: 'hello' });
      else
        await expect(result).rejects.toMatchObject({
          status: outcome === 'invalid-body' ? 400 : 503,
        });
      expect(req.listeners('aborted')).toEqual([existing]);
      expect(res.listeners('close')).toEqual([existing]);
    },
  );
});
