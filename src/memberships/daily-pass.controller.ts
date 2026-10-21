import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';
import { EsMonto } from '../common/validadores';
import { DailyPassService } from './daily-pass.service';

class VisitanteDto {
  @IsString() @MinLength(2) @MaxLength(60) nombre: string;
  @IsOptional() @IsString() @Matches(/^\d{8}$/) dni?: string;
}

export class DailyPassDto {
  @IsUUID('4') operationId: string;
  @IsString() @MaxLength(100) planId: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) versionOferta: string;
  @IsNumber() @Min(0.01) @EsMonto() montoEsperado: number;
  @IsIn(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia']) metodo: string;
  @IsOptional() @IsString() @MaxLength(100) memberId?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => VisitanteDto) visitante?: VisitanteDto;
  @IsBoolean() aceptaTerminos: boolean;
  @IsString() @MaxLength(100) terminosVersion: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) terminosHuella: string;
  @IsBoolean() consentimiento: boolean;
  @IsString() @MaxLength(100) consentimientoVersion: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) consentimientoHuella: string;
}

@Controller('memberships/daily-pass')
@UseGuards(SoloStaffGuard)
export class DailyPassController {
  constructor(private pases: DailyPassService) {}

  @Get('offer') oferta() { return this.pases.oferta(); }

  @Post()
  cobrar(@Body() dto: DailyPassDto, @SesionActual() sesion: Sesion, @Req() req: Request) {
    return this.pases.cobrar(dto, sesion.sub, req.ip);
  }
}
