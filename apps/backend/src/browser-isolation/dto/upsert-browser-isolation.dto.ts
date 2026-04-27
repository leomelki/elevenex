import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsString } from 'class-validator';

export class UpsertBrowserIsolationDto {
  @Type(() => Number)
  @IsInt()
  projectId!: number;

  @IsString()
  @IsIn(['shared', 'isolated'])
  mode!: string;

  @IsArray()
  @IsString({ each: true })
  sharedGlobs!: string[];
}
