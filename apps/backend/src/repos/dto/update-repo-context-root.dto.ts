import { IsOptional, IsString } from 'class-validator';

export class UpdateRepoContextRootDto {
  @IsString()
  @IsOptional()
  preferredContextRootRef?: string | null;
}
