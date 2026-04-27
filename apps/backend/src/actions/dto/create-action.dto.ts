import { IsNotEmpty, IsString } from 'class-validator';

export class CreateActionDto {
  @IsString()
  @IsNotEmpty()
  worktreePath!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  command!: string;
}
