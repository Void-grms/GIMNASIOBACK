import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { RoutinesService } from './routines.service';
import { RankingService } from './ranking.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class EjercicioRutinaDto {
  @IsString() exerciseId: string;
  @IsInt() @Min(1) @Max(10) series: number;
  @IsString() @MaxLength(20) repeticiones: string;
}

class DiaRutinaDto {
  @IsInt() @Min(1) @Max(7) diaSemana: number;
  @IsString() @MaxLength(60) titulo: string;
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(8) grupos: string[];
  @IsArray() @ArrayMaxSize(15) @ValidateNested({ each: true }) @Type(() => EjercicioRutinaDto)
  ejercicios: EjercicioRutinaDto[];
}

class PlantillaDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @MaxLength(60) nombre: string;
  @IsOptional() @IsString() @MaxLength(300) descripcion?: string;
  @IsArray() @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => DiaRutinaDto)
  dias: DiaRutinaDto[];
}

class AsignarDto {
  @IsString() memberId: string;
  @IsString() routineId: string;
  @IsInt() @Min(1) @Max(12) semanas: number;
  @IsOptional() @IsString() @MaxLength(200) nota?: string;
}

/** Lado del entrenador / recepcion. */
@Controller()
@UseGuards(SoloStaffGuard)
export class TrainingController {
  constructor(private routines: RoutinesService, private ranking: RankingService) {}

  @Get('routines')
  plantillas() {
    return this.routines.plantillas();
  }

  @Post('routines')
  guardar(@Body() dto: PlantillaDto) {
    return this.routines.guardarPlantilla(dto);
  }

  @Post('routines/:id/archive')
  archivar(@Param('id') id: string) {
    return this.routines.archivarPlantilla(id);
  }

  @Get('routine-assignments')
  asignaciones() {
    return this.routines.asignaciones();
  }

  @Post('routine-assignments')
  asignar(@Body() dto: AsignarDto, @SesionActual() sesion: Sesion) {
    return this.routines.asignar(dto, sesion.sub);
  }

  @Post('routine-assignments/:id/end')
  terminar(@Param('id') id: string) {
    return this.routines.terminar(id);
  }

  @Get('ranking')
  rankingStaff() {
    return this.ranking.paraStaff();
  }
}

/** Lado del socio. */
@Controller('portal')
export class PortalTrainingController {
  constructor(private routines: RoutinesService, private ranking: RankingService) {}

  private soloSocio(sesion: Sesion) {
    if (!sesion || sesion.tipo !== 'socio') {
      throw new ForbiddenException('Este endpoint es del portal del socio');
    }
    return sesion.sub;
  }

  @Get('routine')
  miRutina(@SesionActual() sesion: Sesion) {
    return this.routines.miRutina(this.soloSocio(sesion));
  }

  @Post('routine/request')
  pedir(@SesionActual() sesion: Sesion, @Body('nota') nota?: string) {
    return this.routines.pedir(this.soloSocio(sesion), typeof nota === 'string' ? nota : undefined);
  }

  @Post('routine/stop')
  dejar(@SesionActual() sesion: Sesion) {
    return this.routines.dejar(this.soloSocio(sesion));
  }

  @Get('ranking')
  miRanking(@SesionActual() sesion: Sesion) {
    return this.ranking.paraSocio(this.soloSocio(sesion));
  }
}
