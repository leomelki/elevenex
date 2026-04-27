import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';

export class ProjectBrowserTabDto {
  @IsString()
  tabId!: string;

  @IsString()
  @IsUrl({ require_tld: false })
  url!: string;

  @Type(() => Number)
  @IsInt()
  position!: number;

  @IsOptional()
  @IsString()
  customTitle?: string | null;
}

export class UpsertProjectBrowserStateDto {
  @Type(() => Number)
  @IsInt()
  projectId!: number;

  @IsOptional()
  @IsString()
  activeTabId!: string | null;

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ProjectBrowserTabDto)
  tabs!: ProjectBrowserTabDto[];
}
