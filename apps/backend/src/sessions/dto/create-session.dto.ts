import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class CreateSessionDto {
  @IsNumber()
  repoId!: number;

  @IsNumber()
  @IsOptional()
  workspaceId?: number;

  @IsNumber()
  @IsOptional()
  folderId?: number;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  branchName?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  worktreePath?: string;

  @IsString()
  @IsOptional()
  name?: string;
}
