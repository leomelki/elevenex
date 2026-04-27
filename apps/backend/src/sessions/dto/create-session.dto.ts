import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class CreateSessionDto {
  @IsNumber()
  repoId!: number;

  @IsString()
  @IsNotEmpty()
  branchName!: string;

  @IsString()
  @IsNotEmpty()
  worktreePath!: string;

  @IsString()
  @IsOptional()
  name?: string;
}