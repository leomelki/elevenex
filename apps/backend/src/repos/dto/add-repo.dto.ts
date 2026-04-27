import { IsString, IsNotEmpty } from 'class-validator';

export class AddRepoDto {
  @IsString()
  @IsNotEmpty()
  path!: string;
}
