import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LinkPoolWorktreeDto {
  @IsString()
  @IsOptional()
  workspaceName?: string;

  @IsString()
  @IsNotEmpty()
  branchName!: string;

  @IsBoolean()
  @IsOptional()
  confirmTakeover?: boolean;

  @IsBoolean()
  @IsOptional()
  confirmStash?: boolean;

  @IsBoolean()
  @IsOptional()
  applyPendingStash?: boolean;
}
