import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Sesion } from './jwt.guard';

export const SesionActual = createParamDecorator((_data, ctx: ExecutionContext): Sesion => {
  return ctx.switchToHttp().getRequest().sesion;
});
