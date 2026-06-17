import { IsIn } from 'class-validator';
import {
  AGENT_AUTONOMY_MODES,
  type AgentAutonomyMode,
} from '../../sessions/sessions.service.js';

export class SetAutonomyDto {
  @IsIn(AGENT_AUTONOMY_MODES)
  autonomyMode!: AgentAutonomyMode;
}
