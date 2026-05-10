import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class GenerateWorktreeContextDto {
  @Type(() => Number)
  @IsNumber()
  repoId!: number;

  @IsString()
  worktreePath!: string;

  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  force?: boolean;

  @IsString()
  @IsOptional()
  rootRef?: string;

  @IsString()
  provider!: string;
}
