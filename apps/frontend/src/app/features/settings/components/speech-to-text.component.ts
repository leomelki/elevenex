import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideLoaderCircle,
  lucideMic,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardCheckboxComponent } from '@/shared/components/checkbox';
import { ZardInputDirective } from '@/shared/components/input';
import {
  OptionSelectComponent,
  OptionSelectItem,
} from '@/shared/components/option-select';
import { AGENT_PROVIDER_PRESENTATIONS } from '@/shared/models/agent-provider-presentation';
import type {
  DefaultAgentProvider,
  SpeechCleanupMode,
  SpeechToTextProviderId,
} from '@/shared/models/app-settings.model';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { LocalWhisperService } from '@/shared/services/local-whisper.service';
import { LocalWhisperSettingsComponent } from './local-whisper.component';
import {
  AudioCaptureSession,
  isRecordingSupported,
} from '@/shared/speech/audio-capture';
import { SpeechToTextApiService } from '@/shared/speech/speech-to-text-api.service';
import { blobToWav16kMono } from '@/shared/speech/wav';

/** How long the "test microphone" button records before transcribing. */
const TEST_RECORDING_MS = 4_000;

const PROVIDER_OPTIONS: OptionSelectItem[] = [
  {
    value: 'local-whisper',
    label: 'On this device',
    description:
      'Whisper, running locally. Free, works offline, and no audio leaves the machine.',
  },
  {
    value: 'elevenlabs',
    label: 'ElevenLabs Scribe',
    description: 'Dedicated speech model. Supports vocabulary biasing.',
  },
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible',
    description:
      'Any /audio/transcriptions route: OpenAI, Groq, DeepInfra, LM Studio, a local server.',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    description:
      'Transcribes by prompting an audio-capable chat model. Less predictable than a dedicated speech model.',
  },
];

const CLEANUP_OPTIONS: OptionSelectItem[] = [
  {
    value: 'off',
    label: 'Off',
    description: 'Insert the transcript exactly as recognised.',
  },
  {
    value: 'session-harness',
    label: "This session's agent",
    description:
      'Reuse whichever agent the session runs on, with its configured model.',
  },
  {
    value: 'fixed',
    label: 'A specific model',
    description: 'Always use the agent and model you pick below.',
  },
];

interface TestResult {
  text: string;
  provider: string;
  model: string;
  transcribeMs: number;
}

@Component({
  selector: 'app-speech-to-text-settings',
  standalone: true,
  imports: [
    FormsModule,
    NgIcon,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputDirective,
    OptionSelectComponent,
    LocalWhisperSettingsComponent,
  ],
  templateUrl: './speech-to-text.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideLoaderCircle,
      lucideMic,
      lucideTriangleAlert,
    }),
  ],
})
export class SpeechToTextSettingsComponent {
  readonly appSettings = inject(AppSettingsService);
  private readonly api = inject(SpeechToTextApiService);
  private readonly localWhisper = inject(LocalWhisperService);

  readonly providerOptions = PROVIDER_OPTIONS;
  readonly cleanupOptions = CLEANUP_OPTIONS;
  readonly agentOptions: OptionSelectItem[] = AGENT_PROVIDER_PRESENTATIONS.map(
    (provider) => ({ value: provider.id, label: provider.label }),
  );

  readonly recordingSupported = isRecordingSupported();

  /** Local draft for the write-only key field; never populated from the server. */
  readonly apiKeyDraft = signal('');
  readonly testing = signal(false);
  readonly testPhase = signal<'idle' | 'recording' | 'transcribing'>('idle');
  readonly testResult = signal<TestResult | null>(null);

  readonly settings = computed(() => this.appSettings.settings().speechToText);
  readonly keyConfigured = computed(
    () => this.appSettings.settings().speechToTextApiKeyConfigured,
  );
  readonly keyFromEnv = computed(
    () => this.appSettings.settings().speechToTextApiKeyFromEnv,
  );

  readonly isOpenAiCompatible = computed(
    () => this.settings().provider === 'openai-compatible',
  );
  readonly isElevenLabs = computed(
    () => this.settings().provider === 'elevenlabs',
  );
  readonly isLocal = computed(() => this.settings().provider === 'local-whisper');
  readonly isFixedCleanup = computed(
    () => this.settings().cleanupMode === 'fixed',
  );

  /** Only the cloud providers have a key or a free-text model id to configure. */
  readonly needsApiKey = computed(
    () => this.appSettings.settings().speechToTextRequiresApiKey,
  );

  readonly modelPlaceholder = computed(() => {
    switch (this.settings().provider) {
      case 'elevenlabs':
        return 'scribe_v2';
      case 'openai-compatible':
        return 'gpt-4o-transcribe';
      default:
        return 'google/gemini-2.5-flash';
    }
  });

  /**
   * The round trip is only worth offering once the chosen provider has what it
   * runs on — a key for the cloud services, downloaded weights for the local
   * engine — otherwise the test can only ever report the same missing setup.
   */
  readonly canTest = computed(() => {
    if (!this.recordingSupported || !this.settings().enabled || this.testing()) {
      return false;
    }
    return this.isLocal()
      ? this.localWhisper.selectedModelReady()
      : this.keyConfigured();
  });

  setEnabled(enabled: boolean): void {
    void this.patch({ enabled });
  }

  setProvider(provider: string): void {
    // Model ids do not carry across providers, so clear the pinned one rather
    // than sending `scribe_v2` to OpenRouter.
    void this.patch({
      provider: provider as SpeechToTextProviderId,
      model: null,
    });
  }

  setBaseUrl(baseUrl: string): void {
    void this.patch({ baseUrl: baseUrl.trim() || null });
  }

  setModel(model: string): void {
    void this.patch({ model: model.trim() || null });
  }

  setLanguage(language: string): void {
    void this.patch({ language: language.trim() || null });
  }

  setKeyterms(keytermsEnabled: boolean): void {
    void this.patch({ keytermsEnabled });
  }

  setAutoSend(autoSend: boolean): void {
    void this.patch({ autoSend });
  }

  setSilenceAutoStop(silenceAutoStop: boolean): void {
    void this.patch({ silenceAutoStop });
  }

  setCleanupMode(cleanupMode: string): void {
    void this.patch({ cleanupMode: cleanupMode as SpeechCleanupMode });
  }

  setCleanupProvider(provider: string): void {
    void this.patch({
      cleanupProvider: (provider || null) as DefaultAgentProvider | null,
    });
  }

  setCleanupModel(cleanupModel: string): void {
    void this.patch({ cleanupModel: cleanupModel.trim() || null });
  }

  async saveApiKey(): Promise<void> {
    const key = this.apiKeyDraft().trim();
    if (!key) {
      return;
    }
    try {
      await this.appSettings.saveSpeechToTextApiKey(key);
      this.apiKeyDraft.set('');
      toast.success('Dictation API key saved');
    } catch {
      toast.error(this.appSettings.error() ?? 'Could not save the API key.');
    }
  }

  async clearApiKey(): Promise<void> {
    try {
      await this.appSettings.saveSpeechToTextApiKey(null);
      this.apiKeyDraft.set('');
      toast.success('Dictation API key removed');
    } catch {
      toast.error(this.appSettings.error() ?? 'Could not remove the API key.');
    }
  }

  /**
   * Records a few seconds and runs the full round trip. Dictation has many
   * independent failure points — permission, codec, key, base URL, model audio
   * support, network — so a one-click check is what makes them diagnosable.
   */
  async runTest(): Promise<void> {
    if (!this.canTest()) {
      return;
    }

    this.testing.set(true);
    this.testResult.set(null);
    this.testPhase.set('recording');

    let session: AudioCaptureSession;
    try {
      session = await AudioCaptureSession.start();
    } catch (error) {
      this.testPhase.set('idle');
      this.testing.set(false);
      toast.error(
        error instanceof Error ? error.message : 'Could not start the microphone.',
      );
      return;
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, TEST_RECORDING_MS));
      const recording = await session.stop();
      this.testPhase.set('transcribing');

      const audio =
        this.settings().provider === 'openrouter'
          ? await blobToWav16kMono(recording.blob)
          : recording.blob;

      const result = await this.api.transcribe({ audio, test: true });
      this.testResult.set({
        text: result.text,
        provider: result.provider,
        model: result.model,
        transcribeMs: result.transcribeMs,
      });
      toast.success('Dictation is working');
    } catch (error) {
      session.cancel();
      toast.error(error instanceof Error ? error.message : 'The test failed.');
    } finally {
      this.testPhase.set('idle');
      this.testing.set(false);
    }
  }

  private async patch(
    patch: Parameters<AppSettingsService['saveSpeechToText']>[0],
  ): Promise<void> {
    try {
      await this.appSettings.saveSpeechToText(patch);
    } catch {
      toast.error(this.appSettings.error() ?? 'Could not save settings.');
    }
  }
}
