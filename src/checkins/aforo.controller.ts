import { Controller, Get } from '@nestjs/common';
import { Publico } from '../auth/publico.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CheckinsService } from './checkins.service';

/**
 * Aforo en vivo para la landing: solo un numero, sin nombres. Sale del mismo
 * conteo exacto de "dentro ahora" que usa recepcion. El administrador puede
 * apagarlo en Ajustes (por ejemplo, si prefiere no mostrar un local vacio).
 */
@Controller('public')
export class AforoController {
  private cache: { valor: any; hasta: number } | null = null;

  constructor(private checkins: CheckinsService, private prisma: PrismaService) {}

  @Publico()
  @Get('aforo')
  async aforo() {
    // Es publico: se guarda 20 segundos para que nadie tumbe la base recargando.
    if (this.cache && this.cache.hasta > Date.now()) return this.cache.valor;

    const ajustes = await this.prisma.settings.findUnique({ where: { id: 'default' } });
    const visible = ajustes?.mostrarAforo ?? true;
    const dentro = visible ? (await this.checkins.sociosDentro()).length : null;
    const maximo = ajustes?.aforoMaximo || 0;
    const valor = {
      visible,
      dentro,
      maximo: maximo || null,
      porcentaje: visible && maximo ? Math.min(100, Math.round(((dentro || 0) / maximo) * 100)) : null,
      actualizado: new Date(),
    };
    this.cache = { valor, hasta: Date.now() + 20000 };
    return valor;
  }
}
