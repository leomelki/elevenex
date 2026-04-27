import { IsString, IsNotEmpty } from 'class-validator';

export class RenameUserTerminalDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}
