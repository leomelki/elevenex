import { Module } from '@nestjs/common';
import { ReviewPreviewController } from './review-preview.controller.js';
import { ReviewPreviewService } from './review-preview.service.js';

@Module({
  controllers: [ReviewPreviewController],
  providers: [ReviewPreviewService],
  exports: [ReviewPreviewService],
})
export class ReviewPreviewModule {}
