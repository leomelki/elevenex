import { Type } from 'class-transformer';
import { IsNumber, IsString } from 'class-validator';

export class GetWorktreeContextDto {
  @Type(() => Number)
  @IsNumber()
  repoId!: number;

  @IsString()
  worktreePath!: string;
}
