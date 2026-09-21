import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { SaludController } from './salud.controller';
import { SystemController } from './system.controller';

@Module({ providers: [BackupService], controllers: [SystemController, SaludController] })
export class SystemModule {}
