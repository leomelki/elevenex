import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class UpdateSectionDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string | null;

  @IsString()
  @IsOptional()
  content?: string;

  @IsBoolean()
  @IsOptional()
  isMarkdown?: boolean;
}