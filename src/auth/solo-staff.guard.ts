import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/** Bloquea los tokens del portal del socio en los endpoints del personal. */
@Injectable()
export class SoloStaffGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const sesion = ctx.switchToHttp().getRequest().sesion;
    if (!sesion || sesion.tipo !== 'staff') {
      throw new ForbiddenException('Solo el personal del gimnasio puede hacer esto');
    }
    return true;
  }
}
