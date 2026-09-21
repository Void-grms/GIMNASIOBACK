import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength,
} from 'class-validator';
import { ComplaintsService } from './complaints.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { Publico } from '../auth/publico.decorator';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class ReclamoDto {
  @IsIn(['reclamo', 'queja'], { message: 'Indica si es un reclamo o una queja' }) tipo: string;

  @IsString() @MinLength(3, { message: 'Escribe tu nombre completo' }) @MaxLength(120) nombre: string;
  @IsIn(['dni', 'ce', 'pasaporte', 'ruc']) tipoDoc: string;
  @IsString() @MinLength(6, { message: 'Numero de documento invalido' }) @MaxLength(15) numDoc: string;
  @IsOptional() @IsString() @MaxLength(20) telefono?: string;
  @IsEmail({}, { message: 'Necesitamos un correo valido para responderte' }) email: string;
  @IsOptional() @IsString() @MaxLength(200) direccion?: string;
  @IsOptional() @IsBoolean() esMenorDeEdad?: boolean;
  @IsOptional() @IsString() @MaxLength(120) apoderado?: string;

  @IsIn(['producto', 'servicio']) bienTipo: string;
  @IsString() @MinLength(3) @MaxLength(200) bienDescripcion: string;
  @IsOptional() @IsNumber() @Min(0) montoReclamado?: number;

  @IsString() @MinLength(10, { message: 'Cuentanos que paso, con algo de detalle' }) @MaxLength(2000)
  detalle: string;

  @IsString() @MinLength(5, { message: 'Dinos que esperas que hagamos' }) @MaxLength(1000)
  pedido: string;

  @IsOptional() @IsString() memberId?: string;
}

class RespuestaDto {
  @IsString() @MinLength(10) @MaxLength(4000) respuesta: string;
}

@Controller('complaints')
export class ComplaintsController {
  constructor(private complaints: ComplaintsService) {}

  /** Publico: cualquiera puede dejar un reclamo sin tener cuenta. */
  @Publico()
  @Post()
  registrar(@Body() dto: ReclamoDto) {
    return this.complaints.registrar(dto);
  }

  @Publico()
  @Get('code/:codigo')
  porCodigo(@Param('codigo') codigo: string) {
    return this.complaints.porCodigo(codigo);
  }

  @Get()
  @UseGuards(SoloStaffGuard)
  listar(@Query('estado') estado?: string) {
    return this.complaints.listar(estado);
  }

  @Post(':id/respond')
  @UseGuards(SoloStaffGuard)
  responder(@Param('id') id: string, @Body() dto: RespuestaDto, @SesionActual() sesion: Sesion) {
    return this.complaints.responder(id, dto.respuesta, sesion.nombre || sesion.sub);
  }
}
