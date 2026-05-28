import { IsIn, IsString } from 'class-validator';
import { CLAUDE_SESSION_SURFACES } from '../settings.types.js';
import type { DefaultClaudeSessionSurface } from '../settings.types.js';

export class UpdateAppSettingsDto {
  @IsString()
  @IsIn(CLAUDE_SESSION_SURFACES)
  defaultClaudeSessionSurface!: DefaultClaudeSessionSurface;
}
