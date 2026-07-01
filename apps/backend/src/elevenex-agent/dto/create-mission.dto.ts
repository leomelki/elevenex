import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsInt,
  IsPositive,
  MaxLength,
} from 'class-validator';
import {
  AGENT_AUTONOMY_MODES,
  type AgentAutonomyMode,
} from '../../sessions/sessions.service.js';

export class CreateMissionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  prompt!: string;

  @IsOptional()
  @IsIn(AGENT_AUTONOMY_MODES)
  autonomyMode?: AgentAutonomyMode;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  /**
   * The code session the user had open in the UI when they launched this
   * mission, if any. Recorded out-of-band (NOT injected into the prompt) so the
   * agent can pull it on demand via `get_focused_session`.
   */
  @IsOptional()
  @IsInt()
  @IsPositive()
  focusedSessionId?: number;
}
