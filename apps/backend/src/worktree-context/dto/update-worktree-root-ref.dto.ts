import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateWorktreeRootRefDto {
  @Type(() => Number)
  @IsNumber()
  repoId!: number;

  @IsString()
  worktreePath!: string;

  @IsString()
  @IsOptional()
  rootRef?: string | null;
}
