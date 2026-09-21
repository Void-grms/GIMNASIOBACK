import { Body, Controller, Get, Header, Post, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { CashService, FiltroCaja } from './cash.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class CerrarCajaDto {
  @IsOptional() @IsString() desde?: string;
  @IsOptional() @IsString() hasta?: string;
  @IsNumber() @Min(0) montoContado: number;
  @IsOptional() @IsString() nota?: string;
}

@Controller('cash')
@UseGuards(SoloStaffGuard)
export class CashController {
  constructor(private cash: CashService) {}

  @Get('summary')
  resumen(@Query() filtro: FiltroCaja) {
    return this.cash.resumen(filtro);
  }

  @Get('payments')
  pagos(@Query() filtro: FiltroCaja) {
    return this.cash.pagos(filtro);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="caja.csv"')
  exportar(@Query() filtro: FiltroCaja) {
    return this.cash.exportarCsv(filtro);
  }

  @Post('close')
  cerrar(@Body() dto: CerrarCajaDto, @SesionActual() sesion: Sesion) {
    return this.cash.cerrar(dto, sesion.sub);
  }

  @Get('closes')
  cierres() {
    return this.cash.historialCierres();
  }
}
