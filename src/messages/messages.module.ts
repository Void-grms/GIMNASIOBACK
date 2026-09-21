import { Module } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesController, PublicReceiptController } from './messages.controller';

@Module({
  providers: [MessagesService],
  controllers: [MessagesController, PublicReceiptController],
})
export class MessagesModule {}
