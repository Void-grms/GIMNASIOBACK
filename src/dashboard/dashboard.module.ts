import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { CheckinsModule } from '../checkins/checkins.module';

@Module({
  imports: [CheckinsModule],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
