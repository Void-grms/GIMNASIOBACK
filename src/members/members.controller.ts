import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { MembersService } from './members.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { EsCelular, EsDni } from '../common/validadores';

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
  @IsOptional() @IsString() @Length(4, 4, { message: 'El PIN debe tener 4 digitos' }) pin?: string;

  /** Consentimiento expreso para el tratamiento de datos (Ley 29733). */
  @IsBoolean({ message: 'Falta registrar el consentimiento del socio' }) consentimiento: boolean;
}

class EditarSocioDto {
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

@Controller('members')
@UseGuards(SoloStaffGuard)
export class MembersController {
  constructor(private members: MembersService) {}

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
