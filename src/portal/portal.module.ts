import { Module } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { MembersModule } from '../members/members.module';
import { CheckinsModule } from '../checkins/checkins.module';
import { TrainingModule } from '../training/training.module';

@Module({
  imports: [MembersModule, CheckinsModule, TrainingModule],
  providers: [PortalService],
  controllers: [PortalController],
})
export class PortalModule {}
