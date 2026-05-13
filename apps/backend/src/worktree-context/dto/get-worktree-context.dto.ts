import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class GetWorktreeContextDto {
  @Type(() => Number)
  @IsNumber()
  repoId!: number;

  @IsString()
  worktreePath!: string;

  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  cachedOnly?: boolean;
}
