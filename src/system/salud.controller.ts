import { Controller, Get } from '@nestjs/common';
import { Publico } from '../auth/publico.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Healthcheck publico: responde 200 solo si la API levanto y la base contesta.
 * No expone nada del negocio (eso esta en /system/health, solo para el staff).
 */
@Controller('salud')
export class SaludController {
  constructor(private prisma: PrismaService) {}

  @Publico()
  @Get()
  async salud() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}
