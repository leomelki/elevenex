import { Module } from '@nestjs/common';
import { TurnChangesService } from './turn-changes.service.js';

@Module({ providers: [TurnChangesService], exports: [TurnChangesService] })
export class TurnChangesModule {}
