import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateWorktreeDto {
  @IsString()
  @IsNotEmpty()
  branchName!: string;

  @IsString()
  @IsOptional()
  worktreePath?: string;

  // Base ref to fork a new branch from (e.g. main, origin/main) when branchName
  // does not exist yet. Ignored when the branch already exists.
  @IsString()
  @IsOptional()
  startPoint?: string;
}
