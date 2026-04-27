import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateActionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  command?: string;
}
