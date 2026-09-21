import { Body, Controller, ForbiddenException, Get, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SettingsService } from './settings.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { Publico } from '../auth/publico.decorator';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';
import { EsRuc } from '../common/validadores';

class AjustesDto {
  @IsOptional() @IsString() razonSocial?: string;
  @IsOptional() @IsString() nombreComercial?: string;
  @IsOptional() @EsRuc({ message: 'El RUC no es valido' }) ruc?: string;
  @IsOptional() @IsString() direccionFiscal?: string;
  @IsOptional() @IsString() telefono?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsIn(['nrus', 'rer', 'rmt', 'general']) regimen?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) igvTasa?: number;
  @IsOptional() @IsNumber() @Min(0) umbralDocumento?: number;
  @IsOptional() @IsIn(['ninguno', 'nubefact']) pseProveedor?: string;
  @IsOptional() @IsString() pseRuc?: string;
  @IsOptional() @IsString() pseToken?: string;
  @IsOptional() @IsString() pseUrl?: string;
  @IsOptional() @IsString() terminosVersion?: string;
  @IsOptional() @IsString() terminosTexto?: string;
  @IsOptional() @IsString() privacidadVersion?: string;
  @IsOptional() @IsString() privacidadTexto?: string;
  @IsOptional() @IsString() consentimientoVersion?: string;
  @IsOptional() @IsString() consentimientoTexto?: string;
  @IsOptional() @Matches(/^(\d{9})?$/, { message: 'El numero de Yape debe tener 9 digitos' }) yapeNumero?: string;
  @IsOptional() @IsString() @MaxLength(80) yapeTitular?: string;
  @IsOptional() @IsInt() @Min(0) @Max(2000) aforoMaximo?: number;
  @IsOptional() @IsBoolean() mostrarAforo?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(20) invitadosPorMes?: number;
}

@Controller('settings')
export class SettingsController {
  constructor(private settings: SettingsService) {}

  /** Publico: la landing necesita los textos legales y el pie de pagina. */
  @Publico()
  @Get()
  publico() {
    return this.settings.publico();
  }

  @Patch()
  @UseGuards(SoloStaffGuard)
  actualizar(@Body() dto: AjustesDto, @SesionActual() sesion: Sesion) {
    // Los datos fiscales y las claves del PSE los toca solo el administrador.
    if (sesion.rol !== 'admin') {
      throw new ForbiddenException('Solo el administrador puede cambiar los ajustes');
    }
    return this.settings.actualizar(dto);
  }
}
