import { Global, Module } from '@nestjs/common';
import { DrizzleProvider, DRIZZLE } from './database.provider.js';

@Global()
@Module({
  providers: [DrizzleProvider],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
