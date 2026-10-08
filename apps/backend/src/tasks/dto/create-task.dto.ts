import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTaskDto {
  @IsString() @IsNotEmpty() @MaxLength(100) requestId!: string;
  @IsString() @IsOptional() @MaxLength(160) name?: string;
  @IsString() @IsNotEmpty() @MaxLength(240) branchName!: string;
  @IsIn(['new', 'existing']) mode!: 'new' | 'existing';
  @IsString() @IsOptional() @MaxLength(240) baseRef?: string;
  @IsIn(['branch', 'snapshot']) @IsOptional() checkoutMode?:
    | 'branch'
    | 'snapshot';
  @IsIn(['automatic', 'new', 'existing']) @IsOptional() environment?:
    | 'automatic'
    | 'new'
    | 'existing';
  @IsInt() @Min(1) @IsOptional() worktreeId?: number;
  @IsBoolean() @IsOptional() confirmOverLimit?: boolean;
  @IsBoolean() @IsOptional() confirmExternal?: boolean;
  @IsBoolean() @IsOptional() useSavedRef?: boolean;
}
