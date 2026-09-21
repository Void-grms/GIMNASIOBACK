import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { EsMonto } from '../common/validadores';
import { MembershipsService } from './memberships.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class ComprobanteDto {
  @IsIn(['boleta', 'factura', 'recibo'], { message: 'Tipo de comprobante invalido' }) tipo: string;
  @IsIn(['dni', 'ruc', 'ce', 'pasaporte', 'sin_documento']) clienteTipoDoc: string;
  @IsOptional() @IsString() @MaxLength(15) clienteNumDoc?: string;
  @IsOptional() @IsString() @MaxLength(150) clienteNombre?: string;
  @IsOptional() @IsString() @MaxLength(200) clienteDireccion?: string;
}

class VenderDto {
  @IsString() memberId: string;
  @IsString() planId: string;
  @IsIn(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'], {
    message: 'Metodo de pago invalido',
  })
  metodo: string;
  @IsOptional() @IsNumber() @Min(0) @EsMonto() monto?: number;
  @IsOptional() @IsString() @MaxLength(300) observacion?: string;

  /** El consumidor acepta las condiciones antes de pagar. */
  @IsBoolean({ message: 'Falta la aceptacion de las condiciones' }) aceptaTerminos: boolean;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => ComprobanteDto)
  comprobante?: ComprobanteDto;
}

@Controller('memberships')
@UseGuards(SoloStaffGuard)
export class MembershipsController {
  constructor(private memberships: MembershipsService) {}

  @Post()
  vender(@Body() dto: VenderDto, @SesionActual() sesion: Sesion) {
    return this.memberships.vender({ ...dto, cajeroId: sesion.sub });
  }

  @Get('preview')
  previsualizar(@Query('memberId') memberId: string, @Query('planId') planId: string) {
    return this.memberships.previsualizar(memberId, planId);
  }

  @Get('member/:memberId')
  listar(@Param('memberId') memberId: string) {
    return this.memberships.listarDeSocio(memberId);
  }

  @Post(':id/anular')
  anular(@Param('id') id: string, @Body('motivo') motivo?: string) {
    return this.memberships.anular(id, motivo);
  }
}
