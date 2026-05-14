import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  path?: string;

  @IsString()
  @IsOptional()
  startPoint?: string;

  @IsBoolean()
  @IsOptional()
  createBranch?: boolean;

  @IsString()
  @IsOptional()
  branchName?: string;
}
