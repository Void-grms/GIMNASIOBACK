import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { IntentosService } from './intentos.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private intentos: IntentosService,
  ) {}

  async loginStaff(email: string, password: string, ip?: string) {
    const correo = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: correo } });

    // Mismo mensaje exista o no el usuario: decir "ese correo no existe" es
    // regalar la mitad de la credencial.
    const generico = 'Correo o contrasena incorrectos';

    if (!user || !user.activo) {
      await this.intentos.registrar('staff', correo, false, ip);
      throw new UnauthorizedException(generico);
    }

    this.intentos.verificarBloqueo(user.bloqueadoHasta);

    if (!bcrypt.compareSync(password, user.passwordHash)) {
      const { intentos, bloqueadoHasta } = this.intentos.siguienteBloqueo(user.intentosFallidos);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { intentosFallidos: intentos, bloqueadoHasta },
      });
      await this.intentos.registrar('staff', correo, false, ip);

      if (bloqueadoHasta) {
        throw new UnauthorizedException(
          'Demasiados intentos fallidos. La cuenta queda bloqueada 15 minutos.',
        );
      }
      throw new UnauthorizedException(
        `${generico}. Te quedan ${this.intentos.intentosRestantes(user.intentosFallidos)} intento(s).`,
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { intentosFallidos: 0, bloqueadoHasta: null },
    });
    await this.intentos.registrar('staff', correo, true, ip);

    const token = await this.jwt.signAsync({
      sub: user.id,
      tipo: 'staff',
      rol: user.rol,
      nombre: user.nombre,
    });
    return {
      access_token: token,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
    };
  }

  async cambiarClave(userId: string, actual: string, nueva: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // 400 y no 401: un 401 haria que el panel cierre la sesion por un simple typo.
    if (!user || !bcrypt.compareSync(actual, user.passwordHash)) {
      throw new BadRequestException('La contrasena actual no es correcta');
    }
    if (actual === nueva) {
      throw new BadRequestException('La nueva contrasena tiene que ser distinta de la actual');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: bcrypt.hashSync(nueva, 10), intentosFallidos: 0, bloqueadoHasta: null },
    });
    return { ok: true };
  }
}
