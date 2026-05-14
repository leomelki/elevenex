import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWorkspaceBranchDto {
  @IsString()
  @IsNotEmpty()
  branchName!: string;

  @IsString()
  @IsOptional()
  startPoint?: string;

  @IsIn(['current-workspace', 'new-workspace', 'branch-only'])
  destination!: 'current-workspace' | 'new-workspace' | 'branch-only';

  @IsString()
  @IsOptional()
  workspaceName?: string;

  @IsString()
  @IsOptional()
  workspacePath?: string;
}
