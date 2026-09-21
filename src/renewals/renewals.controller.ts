import {
  Body, Controller, ForbiddenException, Get, Ip, Param, Post, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { RenewalsService } from './renewals.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class SolicitarDto {
  @IsString() planId: string;
  /** Captura del Yape como data URL (el portal la reduce antes de enviarla). */
  @IsString() @MaxLength(4_500_000) imagen: string;
  @IsOptional() @IsString() @MaxLength(30) operacion?: string;
  @IsBoolean() aceptaTerminos: boolean;
}

/** Lado del socio. */
@Controller('portal/renewals')
export class PortalRenewalsController {
  constructor(private renewals: RenewalsService) {}

  private soloSocio(sesion: Sesion) {
    if (!sesion || sesion.tipo !== 'socio') {
      throw new ForbiddenException('Este endpoint es del portal del socio');
    }
    return sesion.sub;
  }

  @Get('plans')
  planes(@SesionActual() sesion: Sesion) {
    return this.renewals.planes(this.soloSocio(sesion));
  }

  @Get('mine')
  miEstado(@SesionActual() sesion: Sesion) {
    return this.renewals.miEstado(this.soloSocio(sesion));
  }

  @Post()
  solicitar(@SesionActual() sesion: Sesion, @Body() dto: SolicitarDto, @Ip() ip: string) {
    return this.renewals.solicitar(this.soloSocio(sesion), dto, ip);
  }
}

/** Lado de recepcion: revisar la captura y aprobar o rechazar. */
@Controller('renewals')
@UseGuards(SoloStaffGuard)
export class RenewalsController {
  constructor(private renewals: RenewalsService) {}

  @Get()
  pendientes() {
    return this.renewals.pendientes();
  }

  @Get(':id/voucher')
  async comprobante(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(await this.renewals.archivoComprobante(id));
  }

  @Post(':id/approve')
  aprobar(@Param('id') id: string, @SesionActual() sesion: Sesion) {
    return this.renewals.aprobar(id, sesion.sub);
  }

  @Post(':id/reject')
  rechazar(@Param('id') id: string, @Body('motivo') motivo: string, @SesionActual() sesion: Sesion) {
    return this.renewals.rechazar(id, motivo, sesion.sub);
  }
}
