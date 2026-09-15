import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsNotEmpty, IsNumber, IsString, MaxLength } from 'class-validator';

export class CreateSessionFolderDto {
  @IsNumber()
  repoId!: number;

  @IsNumber()
  workspaceId!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;
}

export class RenameSessionFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;
}

export class GroupSessionsDto extends CreateSessionFolderDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsNumber({}, { each: true })
  sessionIds!: number[];
}
