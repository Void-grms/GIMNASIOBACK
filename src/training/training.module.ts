import { Module } from '@nestjs/common';
import { TrainingService } from './training.service';
import { RoutinesService } from './routines.service';
import { RankingService } from './ranking.service';
import { PortalTrainingController, TrainingController } from './training.controller';

@Module({
  providers: [TrainingService, RoutinesService, RankingService],
  controllers: [TrainingController, PortalTrainingController],
  exports: [TrainingService],
})
export class TrainingModule {}
