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
import type {
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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SessionToolbarButtonDto)
  sessionToolbarButtons?: SessionToolbarButtonDto[] | null;
}
