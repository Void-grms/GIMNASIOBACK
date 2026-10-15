import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { PUBLICO } from './publico.decorator';
import { PERMITE_PIN_PENDIENTE } from './pin-pendiente.decorator';
import { PrismaService } from '../prisma/prisma.service';

export type Sesion = { sub: string; tipo: 'staff' | 'socio'; rol?: string; nombre?: string; portalVersion?: number; sessionVersion?: number; debeCambiarPin?: boolean };

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const esPublico = this.reflector.getAllAndOverride<boolean>(PUBLICO, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (esPublico) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Falta el token');
    try {
      req.sesion = await this.jwt.verifyAsync<Sesion>(token);
    } catch {
      throw new UnauthorizedException('Token invalido o vencido');
    }
    const sesion: Sesion = req.sesion;
    if (!sesion.sub || !['staff', 'socio'].includes(sesion.tipo)) throw new UnauthorizedException('Sesion invalida');
    if (sesion.tipo === 'staff') {
      const user = await this.prisma.user.findUnique({ where: { id: sesion.sub }, select: { activo: true, rol: true, sessionVersion: true } });
      if (!user || !user.activo || user.sessionVersion !== (sesion.sessionVersion ?? 0)) throw new UnauthorizedException('Tu acceso cambio. Vuelve a iniciar sesion');
      // Los permisos vigentes mandan sobre el rol que tenia el token al emitirse.
      req.sesion.rol = user.rol;
    } else {
      const socio = await this.prisma.member.findUnique({ where: { id: sesion.sub }, select: { activo: true, dni: true, portalVersion: true, pinCambiado: true, pinTemporalHasta: true } });
      if (!socio || !socio.activo || !/^\d{8}$/.test(socio.dni || '') || socio.portalVersion !== sesion.portalVersion) {
        throw new UnauthorizedException('Tu acceso cambio. Vuelve a iniciar sesion');
      }
      if (!socio.pinCambiado) {
        if (!socio.pinTemporalHasta || socio.pinTemporalHasta.getTime() <= Date.now()) {
          throw new UnauthorizedException('El PIN temporal ha vencido. Solicita otro en recepcion');
        }
        const permitido = this.reflector.getAllAndOverride<boolean>(PERMITE_PIN_PENDIENTE, [ctx.getHandler(), ctx.getClass()]);
        if (!permitido) throw new ForbiddenException('Cambia tu PIN temporal antes de utilizar el portal');
      }
    }
    return true;
  }
}
