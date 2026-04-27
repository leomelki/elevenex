import { IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

class SectionOrder {
  @IsNumber()
  id!: number;

  @IsNumber()
  sortOrder!: number;
}

export class UpdateOrdersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SectionOrder)
  orders!: SectionOrder[];
}