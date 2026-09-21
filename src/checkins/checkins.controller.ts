import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { CheckinsService } from './checkins.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';

class EscanearDto {
  @IsString() codigo: string;
  @IsOptional() @IsString() dispositivo?: string;
}

@Controller('check-ins')
@UseGuards(SoloStaffGuard)
export class CheckinsController {
  constructor(private checkins: CheckinsService) {}

  @Post('scan')
  escanear(@Body() dto: EscanearDto) {
    return this.checkins.escanear(dto.codigo, dto.dispositivo);
  }

  @Get('recent')
  recientes(@Query('limite') limite?: string) {
    return this.checkins.recientes(limite ? Number(limite) : 15);
  }

  /** Quienes estan dentro del gimnasio en este momento. */
  @Get('inside')
  dentro() {
    return this.checkins.listaDentro();
  }

  @Get('arrivals')
  llegadas() {
    return this.checkins.llegadasPendientes();
  }

  @Post('arrivals/:id/confirm')
  confirmar(@Param('id') id: string, @Body('dispositivo') dispositivo?: string) {
    return this.checkins.confirmarLlegada(id, dispositivo);
  }

  @Post('arrivals/:id/dismiss')
  descartar(@Param('id') id: string) {
    return this.checkins.descartarLlegada(id);
  }
}
