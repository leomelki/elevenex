import { IsNotEmpty, IsString } from 'class-validator';

export class UpdateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}
