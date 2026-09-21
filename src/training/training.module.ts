import { Module } from '@nestjs/common';
import { TrainingService } from './training.service';

@Module({ providers: [TrainingService], exports: [TrainingService] })
export class TrainingModule {}
