import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CleanupTranscriptDto {
  /** Raw transcript to tidy. Long dictations skip cleanup service-side. */
  @IsString()
  @MaxLength(20_000)
  text!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  sessionId?: number;

  @IsOptional()
  @IsString()
  worktreePath?: string;
}
