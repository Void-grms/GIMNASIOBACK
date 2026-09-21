import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { esDni, soloDigitos } from '../common/validadores';
import { diaLimaDe, fechaDesdeTexto, hoyLima, rangoEntre, sumarDias } from '../common/fechas';

/**
 * Pases de invitado.
 *
 * Cada socio puede traer a alguien gratis dentro de su cupo mensual. Es el canal
 * de captacion mas barato que tiene un gimnasio de barrio, y lo unico que hace
 * falta para que funcione es que el cupo se controle solo.
 */
@Injectable()
export class GuestsService {
  constructor(private prisma: PrismaService, private settings: SettingsService) {}

  private periodoActual(): string {
    return diaLimaDe(new Date()).slice(0, 7); // YYYY-MM
  }

  async cupo(memberId: string) {
    const ajustes = await this.settings.obtener();
    const periodo = this.periodoActual();
    const usados = await this.prisma.guestPass.count({ where: { memberId, periodo } });
    return {
      periodo,
      limite: ajustes.invitadosPorMes,
      usados,
      restantes: Math.max(0, ajustes.invitadosPorMes - usados),
    };
  }

  async registrar(dto: { memberId: string; nombre: string; dni: string; telefono?: string; nota?: string }) {
    const socio = await this.prisma.member.findUnique({ where: { id: dto.memberId } });
    if (!socio) throw new NotFoundException('Socio no encontrado');
    if (!socio.activo) throw new BadRequestException('El socio esta dado de baja');

    const dni = soloDigitos(dto.dni);
    if (!esDni(dni)) throw new BadRequestException('El DNI del invitado debe tener 8 digitos');
    if (dni === socio.dni) throw new BadRequestException('El invitado no puede ser el mismo socio');

    // Un socio activo no entra como invitado de otro: para eso tiene su membresia.
    const yaSocio = await this.prisma.member.findUnique({ where: { dni } });
    if (yaSocio?.activo) {
      throw new BadRequestException(`${yaSocio.nombres} ya es socio del gimnasio`);
    }

    const cupo = await this.cupo(dto.memberId);
    if (cupo.restantes <= 0) {
      throw new BadRequestException(
        `${socio.nombres} ya uso su cupo de ${cupo.limite} invitado(s) este mes`,
      );
    }

    // Un mismo invitado no puede volver cada mes gratis: eso ya es un socio que
    // no paga. Pasado el primer pase, le toca el pase diario.
    const anterior = await this.prisma.guestPass.findFirst({ where: { dni } });
    if (anterior) {
      throw new BadRequestException(
        'Esa persona ya vino como invitada antes. Ofrecele el pase diario o la membresia.',
      );
    }

    return this.prisma.guestPass.create({
      data: {
        memberId: dto.memberId,
        nombre: dto.nombre.trim(),
        dni,
        telefono: dto.telefono?.trim() || null,
        periodo: cupo.periodo,
        nota: dto.nota?.trim() || null,
      },
      include: { member: true },
    });
  }

  /**
   * Lista de invitados con lo unico que interesa despues: cuantos volvieron
   * como socios. Se calcula mirando si hoy existe un socio con ese DNI.
   */
  async listar(desde?: string, hasta?: string) {
    const d = fechaDesdeTexto(desde, sumarDias(hoyLima(), -30));
    const h = fechaDesdeTexto(hasta, hoyLima());
    const { inicio, fin } = rangoEntre(d, h);

    const pases = await this.prisma.guestPass.findMany({
      where: { createdAt: { gte: inicio, lt: fin } },
      orderBy: { createdAt: 'desc' },
      include: { member: true },
    });

    const dnis = pases.map((p) => p.dni);
    const socios = dnis.length
      ? await this.prisma.member.findMany({ where: { dni: { in: dnis }, activo: true } })
      : [];
    const sociosPorDni = new Set(socios.map((s) => s.dni));

    const lista = pases.map((p) => ({
      id: p.id,
      fecha: p.createdAt,
      dia: diaLimaDe(p.createdAt),
      nombre: p.nombre,
      dni: p.dni,
      telefono: p.telefono,
      nota: p.nota,
      anfitrion: `${p.member.nombres} ${p.member.apellidos}`,
      anfitrionId: p.memberId,
      convertido: sociosPorDni.has(p.dni),
    }));

    const convertidos = lista.filter((g) => g.convertido).length;
    return {
      total: lista.length,
      convertidos,
      tasaConversion: lista.length ? Math.round((convertidos / lista.length) * 100) : 0,
      invitados: lista,
    };
  }
}
