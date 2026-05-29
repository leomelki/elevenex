import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CLAUDE_SESSION_SURFACES } from '../settings.types.js';
import { DEFAULT_AGENT_PROVIDERS } from '../settings.types.js';
import type {
  DefaultAgentProvider,
  DefaultClaudeSessionSurface,
  SessionToolbarButtonSetting,
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
