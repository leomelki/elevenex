import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
}
