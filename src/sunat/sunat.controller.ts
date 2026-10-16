import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import type { Response } from 'express';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';
import { SunatService } from './sunat.service';
class ConfigDto {
  @IsOptional() @IsString() @MaxLength(11) ruc?: string;
  @IsOptional() @IsString() @MaxLength(200) razonSocial?: string;
  @IsOptional() @IsString() @MaxLength(100) nombreComercial?: string;
  @IsOptional() @IsString() @MaxLength(200) direccionFiscal?: string;
  @IsOptional() @Matches(/^(\d{6})?$/) ubigeo?: string;
  @IsOptional() @IsString() @MaxLength(80) departamento?: string;
  @IsOptional() @IsString() @MaxLength(80) provincia?: string;
  @IsOptional() @IsString() @MaxLength(80) distrito?: string;
  @IsOptional()
  @IsIn(['por_confirmar', 'nrus', 'rer', 'rmt', 'general'])
  regimen?: string;
  @IsOptional() @IsString() @MaxLength(100) solUsuario?: string;
  @IsOptional() @IsString() @MaxLength(100) solClave?: string;
}
class PruebaDto {
  @IsIn(['boleta', 'factura']) tipo: string;
  @IsUUID('4') idempotencyKey: string;
}
class CertDto {
  @IsString() @MaxLength(1_400_000) pfxBase64: string;
  @IsString() @MaxLength(200) password: string;
}
@Controller('sunat')
@UseGuards(SoloStaffGuard)
export class SunatController {
  constructor(private sunat: SunatService) {}
  private admin(s: Sesion) {
    if (s.rol !== 'admin')
      throw new ForbiddenException(
        'Solo el administrador puede configurar o probar SUNAT',
      );
  }
  @Get('config') config(@SesionActual() s: Sesion) {
    this.admin(s);
    return this.sunat.configuracion();
  }
  @Patch('config') guardar(@SesionActual() s: Sesion, @Body() d: ConfigDto) {
    this.admin(s);
    return this.sunat.actualizar(d);
  }
  @Post('certificado') certificado(
    @SesionActual() s: Sesion,
    @Body() d: CertDto,
  ) {
    this.admin(s);
    return this.sunat.certificado(d.pfxBase64, d.password);
  }
  @Delete('certificado') quitar(@SesionActual() s: Sesion) {
    this.admin(s);
    return this.sunat.quitarCertificado();
  }
  @Get('pruebas') lista(@SesionActual() s: Sesion) {
    this.admin(s);
    return this.sunat.listar();
  }
  @Post('pruebas') crear(@SesionActual() s: Sesion, @Body() d: PruebaDto) {
    this.admin(s);
    return this.sunat.crear(d.tipo, d.idempotencyKey);
  }
  @Get('pruebas/:id') detalle(
    @SesionActual() s: Sesion,
    @Param('id') id: string,
  ) {
    this.admin(s);
    return this.sunat.detalle(id);
  }
  @Post('pruebas/:id/reintentar') reintentar(
    @SesionActual() s: Sesion,
    @Param('id') id: string,
  ) {
    this.admin(s);
    return this.sunat.reintentar(id);
  }
  @Post('pruebas/:id/consultar') consultar(
    @SesionActual() s: Sesion,
    @Param('id') id: string,
  ) {
    this.admin(s);
    return this.sunat.reintentar(id, true);
  }
  @Get('pruebas/:id/artefactos/:tipo') async archivo(
    @SesionActual() s: Sesion,
    @Param('id') id: string,
    @Param('tipo') tipo: string,
    @Res() res: Response,
  ) {
    this.admin(s);
    if (!['xml', 'cdr'].includes(tipo))
      throw new ForbiddenException('Archivo no permitido');
    const a = await this.sunat.artefacto(id, tipo);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${a.nombre}"`);
    res.type(tipo === 'xml' ? 'application/xml' : 'application/zip');
    res.send(a.buffer);
  }
}
