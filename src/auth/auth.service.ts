import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { IntentosService } from './intentos.service';
import { hashPassword, verifyPassword } from '../common/password';

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

    const coincide = await verifyPassword(password, user.passwordHash);
    const confirmado = await this.intentos.confirmar('staff', {
      id: user.id, hash: user.passwordHash, version: user.sessionVersion, identificador: correo,
    }, coincide, ip);
    if (!confirmado.permitido) {
      this.intentos.verificarBloqueo(confirmado.registro?.bloqueadoHasta);
      throw new UnauthorizedException(generico);
    }
    return this.sesionStaff(confirmado.registro);
  }

  private async sesionStaff(user: any) {
    const token = await this.jwt.signAsync({
      sub: user.id,
      tipo: 'staff',
      rol: user.rol,
      nombre: user.nombre,
      sessionVersion: user.sessionVersion,
    });
    return {
      access_token: token,
      usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
    };
  }

  async cambiarClave(userId: string, actual: string, nueva: string, version?: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // 400 y no 401: un 401 haria que el panel cierre la sesion por un simple typo.
    if (!user || !user.activo || (version !== undefined && user.sessionVersion !== version) || !await verifyPassword(actual, user.passwordHash)) {
      throw new BadRequestException('La contrasena actual no es correcta');
    }
    if (actual === nueva) {
      throw new BadRequestException('La nueva contrasena tiene que ser distinta de la actual');
    }
    if (nueva.length < 8) throw new BadRequestException('La nueva contrasena debe tener al menos 8 caracteres');
    const passwordHash = await hashPassword(nueva);
    const actualizado = await this.prisma.user.updateMany({
      where: { id: userId, activo: true, passwordHash: user.passwordHash, sessionVersion: user.sessionVersion },
      data: { passwordHash, sessionVersion: { increment: 1 }, intentosFallidos: 0, bloqueadoHasta: null },
    });
    if (actualizado.count !== 1) throw new UnauthorizedException('Tu acceso cambio. Vuelve a iniciar sesion');
    return { ok: true, ...await this.sesionStaff({ ...user, sessionVersion: user.sessionVersion + 1 }) };
  }
}
