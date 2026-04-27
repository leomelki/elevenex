import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateWorktreeDto {
  @IsString()
  @IsNotEmpty()
  branchName!: string;

  @IsString()
  @IsOptional()
  worktreePath?: string;
}