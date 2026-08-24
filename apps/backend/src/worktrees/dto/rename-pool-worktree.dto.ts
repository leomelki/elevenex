import { IsNotEmpty, IsString } from 'class-validator';

export class RenamePoolWorktreeDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}
