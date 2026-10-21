import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { EsMonto } from '../common/validadores';
import { MembershipsService } from './memberships.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

export class ComprobanteDto {
  @IsIn(['boleta', 'factura', 'recibo'], { message: 'Tipo de comprobante invalido' }) tipo: string;
  @IsIn(['dni', 'ruc', 'ce', 'pasaporte', 'sin_documento']) clienteTipoDoc: string;
  @IsOptional() @IsString() @MaxLength(15) clienteNumDoc?: string;
  @IsOptional() @IsString() @MaxLength(150) clienteNombre?: string;
  @IsOptional() @IsString() @MaxLength(200) clienteDireccion?: string;
}

export class VenderDto {
  @IsOptional() @IsUUID('4') operationId?: string;
  @IsString() memberId: string;
  @IsString() planId: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/, { message: 'Vuelve a seleccionar el plan para revisar sus condiciones antes de cobrar' }) versionOferta: string;
  @IsIn(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'], {
    message: 'Metodo de pago invalido',
  })
  metodo: string;
  @IsOptional() @IsNumber() @Min(0) @EsMonto() monto?: number;
  @IsOptional() @IsNumber() @Min(0.01) @EsMonto() abonoInicial?: number;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaLimiteSaldo?: string;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaInicio?: string;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) inicioEsperado?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(300) motivoFechas?: string;
  @IsOptional() @IsBoolean() apruebaFechas?: boolean;
  @IsOptional() @IsString() @MaxLength(300) observacion?: string;

  /** El consumidor acepta las condiciones antes de pagar. */
  @IsBoolean({ message: 'Falta la aceptacion de las condiciones' }) aceptaTerminos: boolean;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => ComprobanteDto)
  comprobante?: ComprobanteDto;
}

export class AbonoDto {
  @IsUUID('4') operationId: string;
  @IsNumber() @Min(0.01) @EsMonto() monto: number;
  @IsIn(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia']) metodo: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ComprobanteDto) comprobante?: ComprobanteDto;
}

class AjusteDto {
  @IsUUID('4') operationId: string;
  @IsString() @MinLength(5) @MaxLength(300) motivo: string;
  @IsBoolean() aprobado: boolean;
  @IsInt() @Min(0) version: number;
}
export class FechasMembresiaDto extends AjusteDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaInicio: string;
}
export class CongelamientoDto extends AjusteDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) desde: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) hasta: string;
}

@Controller('memberships')
@UseGuards(SoloStaffGuard)
export class MembershipsController {
  constructor(private memberships: MembershipsService) {}

  private autorizado(sesion: Sesion) {
    if (!sesion || sesion.tipo !== 'staff' || !['admin', 'recepcion'].includes(sesion.rol)) throw new ForbiddenException('Solo administración o recepción pueden gestionar estos cobros y fechas.');
    return sesion.sub;
  }

  @Post()
  vender(@Body() dto: VenderDto, @SesionActual() sesion: Sesion) {
    return this.memberships.vender({ ...dto, cajeroId: this.autorizado(sesion) });
  }

  @Get('preview')
  previsualizar(@Query('memberId') memberId: string, @Query('planId') planId: string, @Query('fechaInicio') fechaInicio: string, @SesionActual() sesion: Sesion) {
    this.autorizado(sesion);
    return this.memberships.previsualizar(memberId, planId, fechaInicio);
  }

  @Get('pendientes')
  pendientes(@SesionActual() sesion: Sesion) { this.autorizado(sesion); return this.memberships.pendientes(); }

  @Get(':id/cuenta')
  cuenta(@Param('id') id: string, @SesionActual() sesion: Sesion) { this.autorizado(sesion); return this.memberships.cuenta(id); }

  @Post(':id/abonos')
  abonar(@Param('id') id: string, @Body() dto: AbonoDto, @SesionActual() sesion: Sesion) { return this.memberships.abonar(id, dto, this.autorizado(sesion)); }

  @Patch(':id/fechas')
  fechas(@Param('id') id: string, @Body() dto: FechasMembresiaDto, @SesionActual() sesion: Sesion) { return this.memberships.ajustarFechas(id, dto, this.autorizado(sesion)); }

  @Post(':id/congelamientos')
  congelar(@Param('id') id: string, @Body() dto: CongelamientoDto, @SesionActual() sesion: Sesion) { return this.memberships.congelar(id, dto, this.autorizado(sesion)); }

  @Get('member/:memberId')
  listar(@Param('memberId') memberId: string, @SesionActual() sesion: Sesion) {
    this.autorizado(sesion);
    return this.memberships.listarDeSocio(memberId);
  }

  @Post(':id/anular')
  anular(@Param('id') id: string, @Body('motivo') motivo: string, @SesionActual() sesion: Sesion) {
    this.autorizado(sesion);
    return this.memberships.anular(id, motivo);
  }
}
