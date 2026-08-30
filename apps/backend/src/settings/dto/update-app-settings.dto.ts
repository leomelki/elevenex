import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CLAUDE_SESSION_SURFACES } from '../settings.types.js';
import { DEFAULT_AGENT_PROVIDERS } from '../settings.types.js';
import type {
  AgentProviderPreferencePatch,
  DefaultAgentProvider,
  DefaultClaudeSessionSurface,
  SessionToolbarButtonSetting,
  SpeechToTextSettings,
} from '../settings.types.js';

class SessionToolbarButtonDto implements SessionToolbarButtonSetting {
  @IsString()
  id!: string;

  @IsBoolean()
  visible!: boolean;
}

export class UpdateAppSettingsDto {
  @IsOptional()
  @IsString()
  @IsIn(CLAUDE_SESSION_SURFACES)
  defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;

  @IsOptional()
  @IsString()
  @IsIn(DEFAULT_AGENT_PROVIDERS)
  defaultAgentProvider?: DefaultAgentProvider;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SessionToolbarButtonDto)
  sessionToolbarButtons?: SessionToolbarButtonDto[] | null;

  // Per-provider patches (`{"claude":"opus"}`, `null` value clears one entry).
  // Keys and values stay open-ended so a new provider or a model released
  // tomorrow needs no backend change; `SettingsService` validates their shape.
  @IsOptional()
  @IsObject()
  defaultModelByProvider?: AgentProviderPreferencePatch | null;

  @IsOptional()
  @IsObject()
  defaultReasoningEffortByProvider?: AgentProviderPreferencePatch | null;

  // Partial dictation patch. Field-level validation lives in `SettingsService.
  // mergeSpeechToTextSettings` so provider ids and cleanup modes are checked
  // against the same constants the rest of the service uses.
  @IsOptional()
  @IsObject()
  speechToText?: Partial<SpeechToTextSettings> | null;

  /**
   * Write-only. Omit to keep the stored key, send `null` or `''` to clear it.
   * Never echoed back — `GET /api/settings` exposes only
   * `speechToTextApiKeyConfigured`.
   */
  @IsOptional()
  @IsString()
  speechToTextApiKey?: string | null;
}

export class CompleteOnboardingDto {
  @IsString()
  @IsIn(DEFAULT_AGENT_PROVIDERS)
  defaultAgentProvider!: DefaultAgentProvider;

  @IsOptional()
  @IsString()
  @IsIn(CLAUDE_SESSION_SURFACES)
  defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;
}
