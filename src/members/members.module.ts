import { Module } from '@nestjs/common';
import { MembersService } from './members.service';
import { MembersController } from './members.controller';
import { AccesoService } from './acceso.service';

@Module({
  providers: [MembersService, AccesoService],
  controllers: [MembersController],
  exports: [MembersService, AccesoService],
})
export class MembersModule {}
