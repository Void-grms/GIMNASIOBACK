import { Body, Controller, Get, Ip, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { Publico } from './publico.decorator';
import { SesionActual } from './sesion.decorator';
import type { Sesion } from './jwt.guard';
import { SoloStaffGuard } from './solo-staff.guard';

class LoginDto {
  @IsEmail({}, { message: 'Correo invalido' })
  email: string;

  @IsString()
  @MinLength(4, { message: 'La contrasena es muy corta' })
  password: string;
}

class CambiarClaveDto {
  @IsString()
  actual: string;

  @IsString()
  @MinLength(8, { message: 'La nueva contrasena debe tener al menos 8 caracteres' })
  // bcrypt solo mira los primeros 72 bytes: mas largo daria una falsa seguridad.
  @MaxLength(72, { message: 'La nueva contrasena es demasiado larga' })
  nueva: string;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  /** 10 intentos por minuto y por IP, antes incluso de tocar la base. */
  @Publico()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.auth.loginStaff(dto.email, dto.password, ip);
  }

  /** Cada persona del staff cambia su propia contrasena (la inicial es temporal). */
  @UseGuards(SoloStaffGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('password')
  cambiarClave(@SesionActual() sesion: Sesion, @Body() dto: CambiarClaveDto) {
    return this.auth.cambiarClave(sesion.sub, dto.actual, dto.nueva);
  }

  @Get('me')
  me(@SesionActual() sesion: Sesion) {
    return sesion;
  }
}
