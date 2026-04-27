import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateUserTerminalDto {
  @IsString()
  @IsNotEmpty()
  worktreePath!: string;

  @IsString()
  @IsOptional()
  name?: string;
}
