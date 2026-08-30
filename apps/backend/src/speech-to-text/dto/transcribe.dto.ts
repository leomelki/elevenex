import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class TranscribeQueryDto {
  /** Session the dictation belongs to; supplies worktree, branch and harness. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sessionId?: number;

  /** Explicit worktree, for composers that are not tied to a session. */
  @IsOptional()
  @IsString()
  worktreePath?: string;
}
