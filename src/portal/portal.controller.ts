import {
  Body, Controller, Delete, ForbiddenException, Get, Ip, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Length, Max,
  MaxLength, Min, ValidateNested,
} from 'class-validator';
import { PortalService } from './portal.service';
import { CheckinsService } from '../checkins/checkins.service';
import { TrainingService } from '../training/training.service';
import { Publico } from '../auth/publico.decorator';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class LoginSocioDto {
  @IsString() @Length(8, 8) dni: string;
  @IsString() @Length(4, 4) pin: string;
}

class PerfilDto {
  @IsOptional() @IsString() telefono?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() @Length(4, 4) pinActual?: string;
  @IsOptional() @IsString() @Length(4, 4) pinNuevo?: string;
  @IsOptional() @IsBoolean() ocultarEnRanking?: boolean;
}

class SerieDto {
  @IsInt({ message: 'Las repeticiones deben ser un numero entero' })
  @Min(1) @Max(200)
  repeticiones: number;

  @IsNumber() @Min(0, { message: 'El peso no puede ser negativo' }) @Max(500)
  pesoKg: number;
}

class EntrenamientoDto {
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() exerciseId?: string;
  @IsOptional() @IsString() @MaxLength(80) nombreEjercicio?: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => SerieDto)
  series: SerieDto[];

  @IsOptional() @IsString() @MaxLength(200) nota?: string;
}

class PesoDto {
  @IsOptional() @IsString() fecha?: string;
  @IsNumber() @Min(20) @Max(400) pesoKg: number;
  @IsOptional() @IsNumber() @Min(30) @Max(250) cinturaCm?: number;
  @IsOptional() @IsString() @MaxLength(200) nota?: string;
}

@Controller('portal')
export class PortalController {
  constructor(
    private portal: PortalService,
    private checkins: CheckinsService,
    private training: TrainingService,
  ) {}

  private soloSocio(sesion: Sesion) {
    if (!sesion || sesion.tipo !== 'socio') {
      throw new ForbiddenException('Este endpoint es del portal del socio');
    }
    return sesion.sub;
  }

  /**
   * Cinco intentos por minuto y por IP. El usuario es el DNI, que no es
   * secreto, asi que sin esto el PIN de cuatro digitos se adivina solo.
   */
  @Publico()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  login(@Body() dto: LoginSocioDto, @Ip() ip: string) {
    return this.portal.login(dto.dni, dto.pin, ip);
  }

  @Get('me')
  miPanel(@SesionActual() sesion: Sesion) {
    return this.portal.miPanel(this.soloSocio(sesion));
  }

  @Patch('me')
  editarPerfil(@SesionActual() sesion: Sesion, @Body() dto: PerfilDto) {
    return this.portal.actualizarPerfil(this.soloSocio(sesion), dto);
  }

  @Post('foto')
  foto(@SesionActual() sesion: Sesion, @Body('imagen') imagen: string) {
    return this.portal.actualizarFoto(this.soloSocio(sesion), imagen);
  }

  @Get('qr')
  miQr(@SesionActual() sesion: Sesion) {
    return this.portal.miQr(this.soloSocio(sesion));
  }

  /**
   * Un solo boton que cambia con el estado: fuera avisa la llegada a recepcion,
   * dentro registra la salida. Entrar necesita confirmacion de recepcion;
   * salir no necesita permiso de nadie, pero si `confirmarSalida: true`.
   */
  @Post('presence')
  alternarPresencia(
    @SesionActual() sesion: Sesion,
    @Body('confirmarSalida') confirmarSalida?: boolean,
  ) {
    return this.checkins.alternarPresencia(this.soloSocio(sesion), confirmarSalida === true);
  }

  @Get('presence')
  presencia(@SesionActual() sesion: Sesion) {
    return this.checkins.presencia(this.soloSocio(sesion));
  }

  // --------------------------------------------------------- entrenamiento

  @Get('exercises')
  ejercicios() {
    return this.training.listarEjercicios();
  }

  @Get('my-exercises')
  misEjercicios(@SesionActual() sesion: Sesion) {
    return this.training.misEjercicios(this.soloSocio(sesion));
  }

  @Post('workouts')
  registrarEntrenamiento(@SesionActual() sesion: Sesion, @Body() dto: EntrenamientoDto) {
    return this.training.registrar(this.soloSocio(sesion), dto);
  }

  @Get('workouts')
  historial(
    @SesionActual() sesion: Sesion,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    return this.training.historial(this.soloSocio(sesion), desde, hasta);
  }

  @Get('progress/:exerciseId')
  progreso(@SesionActual() sesion: Sesion, @Param('exerciseId') exerciseId: string) {
    return this.training.progreso(this.soloSocio(sesion), exerciseId);
  }

  // ---------------------------------------------------------- peso corporal

  @Get('health-consent')
  estadoSalud(@SesionActual() sesion: Sesion) {
    return this.training.estadoConsentimientoSalud(this.soloSocio(sesion));
  }

  @Post('health-consent')
  aceptarSalud(@SesionActual() sesion: Sesion, @Body('texto') texto: string) {
    return this.training.aceptarSalud(this.soloSocio(sesion), texto || '');
  }

  @Delete('health-consent')
  revocarSalud(@SesionActual() sesion: Sesion) {
    return this.training.revocarSalud(this.soloSocio(sesion));
  }

  @Get('body')
  pesos(@SesionActual() sesion: Sesion) {
    return this.training.pesos(this.soloSocio(sesion));
  }

  @Post('body')
  registrarPeso(@SesionActual() sesion: Sesion, @Body() dto: PesoDto) {
    return this.training.registrarPeso(this.soloSocio(sesion), dto);
  }

  @Delete('body/:id')
  borrarPeso(@SesionActual() sesion: Sesion, @Param('id') id: string) {
    return this.training.borrarPeso(this.soloSocio(sesion), id);
  }
}
