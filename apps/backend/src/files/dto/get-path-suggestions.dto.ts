import { IsIn, IsOptional, IsString } from 'class-validator';

export class GetPathSuggestionsDto {
  @IsString()
  @IsOptional()
  input?: string;

  @IsString()
  @IsOptional()
  @IsIn(['file', 'directory', 'either'])
  targetKind?: 'file' | 'directory' | 'either';

  @IsString()
  @IsOptional()
  preferredStartDirectory?: string;
}
