import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsString } from 'class-validator';

export class UpdateWorktreeContextEnabledDto {
  @Type(() => Number)
  @IsNumber()
  repoId!: number;

  @IsString()
  worktreePath!: string;

  @IsBoolean()
  contextEnabled!: boolean;
}
