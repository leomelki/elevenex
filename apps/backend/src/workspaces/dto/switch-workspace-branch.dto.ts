import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SwitchWorkspaceBranchDto {
  @IsString()
  @IsNotEmpty()
  branchName!: string;

  @IsBoolean()
  @IsOptional()
  force?: boolean;
}
