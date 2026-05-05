import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class ConsumeWorktreeContextDto {
  @Type(() => Number)
  @IsNumber()
  sessionId!: number;

  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  contextSentence?: string;
}
