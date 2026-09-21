import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Casilleros. Se ocupan al cobrar el alquiler (ver ProductsService.vender) y
 * se liberan solos cuando el socio marca su salida (CheckinsService). Aqui
 * queda lo que recepcion ve y toca a mano: la grilla, cuantos hay y liberar
 * uno cuando alguien devuelve la llave sin pasar por la salida.
 */
@Injectable()
export class LockersService {
  /** Pasado esto, la grilla marca el casillero en ambar: alguien lo olvido. */
  private readonly HORAS_AVISO = 3;

  constructor(private prisma: PrismaService) {}

  async listar() {
    const casilleros = await this.prisma.locker.findMany({
      where: { activo: true },
      orderBy: { numero: 'asc' },
      include: { member: true },
    });
    return casilleros.map((c) => {
      const minutos = c.ocupadoDesde
        ? Math.round((Date.now() - c.ocupadoDesde.getTime()) / 60000)
        : null;
      return {
        numero: c.numero,
        libre: !c.memberId,
        desde: c.ocupadoDesde,
        minutos,
        demorado: minutos !== null && minutos > this.HORAS_AVISO * 60,
        socio: c.member
          ? { id: c.member.id, nombreCompleto: `${c.member.nombres} ${c.member.apellidos}`, dni: c.member.dni }
          : null,
      };
    });
  }

  /**
   * Fija cuantos casilleros hay, numerados del 1 al total. Bajar el total no
   * borra filas: desactiva los numeros sobrantes, y solo si estan libres.
   */
  async configurar(total: number) {
    if (!Number.isInteger(total) || total < 0 || total > 500) {
      throw new BadRequestException('El total de casilleros debe estar entre 0 y 500');
    }
    const ocupadosFuera = await this.prisma.locker.count({
      where: { numero: { gt: total }, memberId: { not: null } },
    });
    if (ocupadosFuera > 0) {
      throw new BadRequestException(
        'Hay casilleros ocupados por encima de ese numero. Liberalos antes de reducir el total.',
      );
    }
    const existentes = await this.prisma.locker.findMany({ select: { numero: true } });
    const hay = new Set(existentes.map((e) => e.numero));
    const nuevos = [];
    for (let n = 1; n <= total; n++) if (!hay.has(n)) nuevos.push({ numero: n });
    if (nuevos.length) await this.prisma.locker.createMany({ data: nuevos });
    await this.prisma.locker.updateMany({ where: { numero: { lte: total } }, data: { activo: true } });
    await this.prisma.locker.updateMany({ where: { numero: { gt: total } }, data: { activo: false } });
    return this.listar();
  }

  async liberar(numero: number) {
    const casillero = await this.prisma.locker.findUnique({ where: { numero } });
    if (!casillero) throw new NotFoundException('Casillero no encontrado');
    await this.prisma.locker.update({
      where: { numero },
      data: { memberId: null, ocupadoDesde: null },
    });
    return { ok: true };
  }
}
