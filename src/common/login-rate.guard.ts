import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LoginRateService } from './login-rate.service';

/** Limita cada cuenta/enlace sin agotar el cupo de los demas socios del Wi-Fi. */
@Injectable()
export class LoginRateGuard implements CanActivate {
  constructor(private rates: LoginRateService, private reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const handler = context.getHandler();
    const route = `${context.getClass().name}:${handler.name}`;
    const metadata = [handler, context.getClass()];
    const limit = this.reflector.getAllAndOverride<number>('THROTTLER:LIMITdefault', metadata) || 5;
    const ttl = this.reflector.getAllAndOverride<number>('THROTTLER:TTLdefault', metadata) || 60000;
    const body = req.body || {};
    const identidad = String(req.sesion?.sub || body.dni || body.email || body.token || 'sin-identidad').trim().slice(0, 256);
    const cuentaNormalizada = body.email ? identidad.toLowerCase() : identidad;

    const ip = await this.rates.tomar(`ip:${req.ip || 'desconocida'}`, 1200, 60000);
    if (!ip.permitido) this.rechazar(res, ip.reintentarEn);
    const cuenta = await this.rates.tomar(`cuenta:${route}:${cuentaNormalizada}`, limit, ttl);
    res.header('X-RateLimit-Limit', limit);
    res.header('X-RateLimit-Remaining', cuenta.restantes);
    res.header('X-RateLimit-Reset', cuenta.reintentarEn);
    if (!cuenta.permitido) this.rechazar(res, cuenta.reintentarEn);
    return true;
  }

  private rechazar(res: any, seconds: number): never {
    res.header('Retry-After', seconds);
    throw new HttpException('Demasiados intentos. Espera un minuto y vuelve a probar.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
