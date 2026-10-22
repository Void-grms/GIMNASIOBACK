import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { SaludController } from './salud.controller';
import { SystemController } from './system.controller';
import { ImagenesExistentesService } from './imagenes-existentes.service';

@Module({ providers: [BackupService, ImagenesExistentesService], controllers: [SystemController, SaludController] })
export class SystemModule {}
