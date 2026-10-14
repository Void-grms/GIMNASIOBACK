import { Body, Controller, Get, Ip, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { MembersService } from './members.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { EsCelular, EsDni } from '../common/validadores';
import { AccesoService } from './acceso.service';

class CrearSocioDto {
  @EsDni() dni: string;
  @IsString() @MinLength(2, { message: 'El nombre es muy corto' }) @MaxLength(60) nombres: string;
  @IsString() @MinLength(2, { message: 'El apellido es muy corto' }) @MaxLength(60) apellidos: string;
  @IsOptional() @EsCelular() telefono?: string;
  @IsOptional() @IsEmail({}, { message: 'El correo no es valido' }) email?: string;
  @IsOptional() @IsString() @MaxLength(200) direccion?: string;
  @IsOptional() @IsString() fotoUrl?: string;
  @IsOptional() @IsBoolean() esUniversitario?: boolean;
  @IsOptional() @IsString() @MaxLength(500) notas?: string;
  @IsOptional() @IsString() @MaxLength(64) codigoERP?: string;

  /** Consentimiento expreso para el tratamiento de datos (Ley 29733). */
  @IsBoolean({ message: 'Falta registrar el consentimiento del socio' }) consentimiento: boolean;
}

class EditarSocioDto {
  @IsOptional() @EsDni() dni?: string;
  @IsOptional() @IsString() @MaxLength(64) codigoERP?: string;
  @IsOptional() @IsBoolean() identidadVerificada?: boolean;
  @IsOptional() @IsString() @MaxLength(60) nombres?: string;
  @IsOptional() @IsString() @MaxLength(60) apellidos?: string;
  @IsOptional() @EsCelular() telefono?: string;
  @IsOptional() @IsEmail({}, { message: 'El correo no es valido' }) email?: string;
  @IsOptional() @IsString() @MaxLength(200) direccion?: string;
  @IsOptional() @IsString() fotoUrl?: string;
  @IsOptional() @IsBoolean() esUniversitario?: boolean;
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsOptional() @IsString() notas?: string;
  @IsOptional() @IsString() @Length(4, 4) pin?: string;
}

class AccesoDto {
  @IsBoolean() identidadVerificada: boolean;
  @IsOptional() @IsBoolean() consentimiento?: boolean;
  @IsOptional() @IsString() @MaxLength(100) consentimientoVersion?: string;
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/) consentimientoHuella?: string;
}

@Controller('members')
@UseGuards(SoloStaffGuard)
export class MembersController {
  constructor(private members: MembersService, private acceso: AccesoService) {}

  @Get()
  listar(@Query('q') q?: string) {
    return this.members.buscar(q);
  }

  @Post()
  crear(@Body() dto: CrearSocioDto) {
    return this.members.crear(dto);
  }

  @Get(':id')
  obtener(@Param('id') id: string) {
    return this.members.obtener(id);
  }

  @Patch(':id')
  editar(@Param('id') id: string, @Body() dto: EditarSocioDto) {
    return this.members.actualizar(id, dto);
  }

  @Post(':id/acceso-pin')
  accesoPin(@Param('id') id: string, @Body() dto: AccesoDto, @Ip() ip: string) {
    return this.acceso.emitirPin(id, dto, ip);
  }

  @Post(':id/activacion')
  activacion(@Param('id') id: string, @Body() dto: AccesoDto, @Ip() ip: string) {
    return this.acceso.emitirActivacion(id, dto, ip);
  }

  /** Foto tomada con la webcam de recepcion, en base64. */
  @Post(':id/foto')
  foto(@Param('id') id: string, @Body('imagen') imagen: string) {
    return this.members.guardarFoto(id, imagen);
  }

  /** Derecho de acceso: copia de todo lo que el gimnasio guarda del socio. */
  @Get(':id/datos')
  datos(@Param('id') id: string) {
    return this.members.exportarDatos(id);
  }

  /** Derecho de supresion: borra la identidad y conserva lo que exige SUNAT. */
  @Post(':id/anonimizar')
  anonimizar(@Param('id') id: string, @Body('motivo') motivo: string) {
    return this.members.anonimizar(id, motivo);
  }
}
