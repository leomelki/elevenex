import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AttachWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  path!: string;

  @IsString()
  @IsOptional()
  name?: string;
}
