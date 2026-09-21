import { Module } from '@nestjs/common';
import { RenewalsService } from './renewals.service';
import { PortalRenewalsController, RenewalsController } from './renewals.controller';
import { MembershipsModule } from '../memberships/memberships.module';
import { MembersModule } from '../members/members.module';

@Module({
  imports: [MembershipsModule, MembersModule],
  providers: [RenewalsService],
  controllers: [PortalRenewalsController, RenewalsController],
})
export class RenewalsModule {}
