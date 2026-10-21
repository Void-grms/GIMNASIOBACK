import { Module } from '@nestjs/common';
import { MembershipsService } from './memberships.service';
import { MembershipsController } from './memberships.controller';
import { MembersModule } from '../members/members.module';
import { DailyPassController } from './daily-pass.controller';
import { DailyPassService } from './daily-pass.service';

@Module({
  imports: [MembersModule],
  providers: [MembershipsService, DailyPassService],
  controllers: [DailyPassController, MembershipsController],
  exports: [MembershipsService],
})
export class MembershipsModule {}
