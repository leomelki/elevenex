import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPEECH_TO_TEXT_SETTINGS,
  type AppSettings,
} from '@/shared/models/app-settings.model';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { DictationService, type DictationTarget } from './dictation.service';
import { SpeechToTextApiService } from './speech-to-text-api.service';
import * as audioCapture from './audio-capture';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultClaudeSessionSurface: 'claude-ui',
    defaultAgentProvider: 'claude',
    sessionToolbarButtons: null,
    defaultModelByProvider: {},
    defaultReasoningEffortByProvider: {},
    speechToText: { ...DEFAULT_SPEECH_TO_TEXT_SETTINGS, enabled: true },
    speechToTextApiKeyConfigured: true,
    speechToTextApiKeyFromEnv: false,
    onboardingCompletedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeTarget(): DictationTarget & {
  inserted: string[];
  replaced: string[];
  submitted: number;
} {
  return {
    dictationId: 'target-1',
    dictationSessionId: 7,
    dictationWorktreePath: '/repo',
    inserted: [],
    replaced: [],
    submitted: 0,
    canDictate: () => true,
    insertDictation(text: string) {
      this.inserted.push(text);
    },
    replaceDictation(text: string) {
      this.replaced.push(text);
      return true;
    },
    focusTarget: () => undefined,
    submitTarget() {
      this.submitted += 1;
    },
  };
}

describe('DictationService', () => {
  const settingsSignal = signal<AppSettings>(makeSettings());
  let transcribe: ReturnType<typeof vi.fn>;
  let cleanup: ReturnType<typeof vi.fn>;
  let service: DictationService;

  beforeEach(() => {
    // jsdom has neither, and `DictationService.supported` is evaluated when the
    // service is constructed — so these must be in place before `inject`.
    const recorderStub = vi.fn() as unknown as typeof MediaRecorder;
    (
      recorderStub as unknown as { isTypeSupported: (t: string) => boolean }
    ).isTypeSupported = () => true;
    globalThis.MediaRecorder = recorderStub;
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });

    settingsSignal.set(makeSettings());
    transcribe = vi.fn(async () => ({
      text: 'fix the composer',
      provider: 'elevenlabs' as const,
      model: 'scribe_v2',
      transcribeMs: 120,
      cleanupAvailable: false,
    }));
    cleanup = vi.fn(async () => ({
      text: 'fix the composer',
      applied: false,
      elapsedMs: 0,
    }));

    TestBed.configureTestingModule({
      providers: [
        DictationService,
        { provide: AppSettingsService, useValue: { settings: settingsSignal } },
        { provide: SpeechToTextApiService, useValue: { transcribe, cleanup } },
      ],
    });
    service = TestBed.inject(DictationService);
  });

  describe('availability', () => {
    it('explains that dictation is off rather than silently doing nothing', () => {
      settingsSignal.set(
        makeSettings({
          speechToText: { ...DEFAULT_SPEECH_TO_TEXT_SETTINGS, enabled: false },
        }),
      );
      expect(service.unavailableReason()).toMatch(/off/i);
    });

    it('explains a missing API key', () => {
      settingsSignal.set(makeSettings({ speechToTextApiKeyConfigured: false }));
      expect(service.unavailableReason()).toMatch(/API key/i);
    });

    it('refuses to start and reports why when unavailable', async () => {
      settingsSignal.set(makeSettings({ speechToTextApiKeyConfigured: false }));
      await service.start(makeTarget());

      expect(service.state()).toBe('idle');
      expect(service.error()).toMatch(/API key/i);
    });
  });

  describe('single-session enforcement', () => {
    it('ignores a second start while one is already active', async () => {
      const started = vi.spyOn(audioCapture.AudioCaptureSession, 'start');
      // Never resolves: models a permission prompt sitting open.
      started.mockImplementation(() => new Promise(() => {}));

      void service.start(makeTarget());
      const second = { ...makeTarget(), dictationId: 'target-2' };
      await service.start(second);

      expect(started).toHaveBeenCalledTimes(1);
      expect(service.activeTargetId()).toBe('target-1');
      started.mockRestore();
    });
  });

  describe('cancel during a pending permission prompt', () => {
    it('releases the microphone rather than leaving it live', async () => {
      let resolveStart: (session: audioCapture.AudioCaptureSession) => void =
        () => undefined;
      const fakeSession = { cancel: vi.fn(), mediaStream: null };
      const started = vi
        .spyOn(audioCapture.AudioCaptureSession, 'start')
        .mockImplementation(
          () =>
            new Promise<audioCapture.AudioCaptureSession>((resolve) => {
              resolveStart = resolve;
            }),
        );

      const pending = service.start(makeTarget());
      expect(service.state()).toBe('requesting');

      // User releases the button (or hits Escape) before answering the prompt.
      service.cancel();
      expect(service.state()).toBe('idle');

      // The prompt is then granted and the stream finally arrives.
      resolveStart(fakeSession as unknown as audioCapture.AudioCaptureSession);
      await pending;

      expect(fakeSession.cancel).toHaveBeenCalledTimes(1);
      expect(service.state()).toBe('idle');
      started.mockRestore();
    });
  });

  describe('transcription', () => {
    it('inserts the transcript and does not submit when auto-send is off', async () => {
      const target = makeTarget();
      const fakeSession = {
        cancel: vi.fn(),
        mediaStream: null,
        stop: vi.fn(async () => ({
          blob: new Blob(['x'], { type: 'audio/webm' }),
          mimeType: 'audio/webm',
          durationMs: 1200,
        })),
      };
      const started = vi
        .spyOn(audioCapture.AudioCaptureSession, 'start')
        .mockResolvedValue(fakeSession as unknown as audioCapture.AudioCaptureSession);

      await service.start(target);
      await service.stop();

      expect(target.inserted).toEqual(['fix the composer']);
      expect(target.submitted).toBe(0);
      expect(service.state()).toBe('idle');
      started.mockRestore();
    });

    it('reports empty speech instead of inserting nothing', async () => {
      transcribe.mockResolvedValue({
        text: '   ',
        provider: 'elevenlabs',
        model: 'scribe_v2',
        transcribeMs: 90,
        cleanupAvailable: false,
      });
      const target = makeTarget();
      const fakeSession = {
        cancel: vi.fn(),
        mediaStream: null,
        stop: vi.fn(async () => ({
          blob: new Blob(['x'], { type: 'audio/webm' }),
          mimeType: 'audio/webm',
          durationMs: 1200,
        })),
      };
      const started = vi
        .spyOn(audioCapture.AudioCaptureSession, 'start')
        .mockResolvedValue(fakeSession as unknown as audioCapture.AudioCaptureSession);

      await service.start(target);
      await service.stop();

      expect(target.inserted).toEqual([]);
      expect(service.error()).toMatch(/no speech/i);
      started.mockRestore();
    });
  });
});
