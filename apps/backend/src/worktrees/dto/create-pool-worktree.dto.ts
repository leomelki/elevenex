import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreatePoolWorktreeDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  startPoint!: string;

  @IsString()
  @IsOptional()
  branchName?: string;

  @IsString()
  @IsOptional()
  path?: string;

  /**
   * Set once the human has acknowledged the "you have reached the worktree
   * limit" warning and asked to create one anyway.
   */
  @IsBoolean()
  @IsOptional()
  confirmOverLimit?: boolean;
}
