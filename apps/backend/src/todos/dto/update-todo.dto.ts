import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class UpdateTodoDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  text?: string;

  @IsBoolean()
  @IsOptional()
  completed?: boolean;
}