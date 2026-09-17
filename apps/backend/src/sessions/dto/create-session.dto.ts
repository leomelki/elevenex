import { IsString, IsNotEmpty, IsNumber, IsOptional, IsBoolean } from 'class-validator';

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

  @IsBoolean()
  @IsOptional()
  isTemporary?: boolean;
}
