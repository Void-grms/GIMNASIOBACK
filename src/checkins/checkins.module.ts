import { Module } from '@nestjs/common';
import { CheckinsService } from './checkins.service';
import { CheckinsController } from './checkins.controller';
import { AforoController } from './aforo.controller';
import { MembersModule } from '../members/members.module';

@Module({
  imports: [MembersModule],
  providers: [CheckinsService],
  controllers: [CheckinsController, AforoController],
  exports: [CheckinsService],
})
export class CheckinsModule {}
