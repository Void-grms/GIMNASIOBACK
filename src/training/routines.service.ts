import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hoyLima, sumarDias } from '../common/fechas';

export const DIAS_SEMANA = ['', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado', 'Domingo'];

type DiaDto = {
  diaSemana: number;
  titulo: string;
  grupos: string[];
  ejercicios: { exerciseId: string; series: number; repeticiones: string }[];
};

/**
 * Rutinas del entrenador. La mayoria de socios entrena a su manera, asi que la
 * rutina es opt-in: solo la ve quien la pide, y el portal solo ofrece pedirla
 * a quien recien empieza. El entrenador la asigna por unas semanas y despues
 * termina sola.
 */
@Injectable()
export class RoutinesService {
  /** "Recien empieza": inscrito hace menos de esto o con pocas visitas. */
  private readonly DIAS_NUEVO = 45;
  private readonly VISITAS_NUEVO = 12;

  constructor(private prisma: PrismaService) {}

  /** 1 = lunes ... 7 = domingo, en el dia de Lima. */
  private diaSemanaHoy() {
    const d = hoyLima().getUTCDay();
    return d === 0 ? 7 : d;
  }

  // ---------------------------------------------------------- plantillas

  async plantillas() {
    const rutinas = await this.prisma.routine.findMany({
      where: { activo: true },
      orderBy: { nombre: 'asc' },
      include: {
        dias: {
          orderBy: { diaSemana: 'asc' },
          include: { ejercicios: { orderBy: { orden: 'asc' }, include: { exercise: true } } },
        },
        _count: { select: { asignaciones: { where: { estado: 'activa' } } } },
      },
    });
    return rutinas.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      descripcion: r.descripcion,
      activos: r._count.asignaciones,
      dias: r.dias.map((d) => this.formatoDia(d)),
    }));
  }

  private formatoDia(d: any) {
    return {
      diaSemana: d.diaSemana,
      nombreDia: DIAS_SEMANA[d.diaSemana],
      titulo: d.titulo,
      grupos: d.grupos ? d.grupos.split(',').filter(Boolean) : [],
      ejercicios: d.ejercicios.map((e: any) => ({
        exerciseId: e.exerciseId,
        nombre: e.exercise?.nombre,
        grupo: e.exercise?.grupo,
        series: e.series,
        repeticiones: e.repeticiones,
      })),
    };
  }

  async guardarPlantilla(dto: { id?: string; nombre: string; descripcion?: string; dias: DiaDto[] }) {
    const nombre = (dto.nombre || '').trim();
    if (nombre.length < 3) throw new BadRequestException('Ponle un nombre a la rutina');
    if (!dto.dias?.length) throw new BadRequestException('La rutina necesita al menos un dia');
    const vistos = new Set<number>();
    for (const d of dto.dias) {
      if (!Number.isInteger(d.diaSemana) || d.diaSemana < 1 || d.diaSemana > 7) {
        throw new BadRequestException('Dia de la semana invalido');
      }
      if (vistos.has(d.diaSemana)) {
        throw new BadRequestException(`${DIAS_SEMANA[d.diaSemana]} aparece dos veces`);
      }
      vistos.add(d.diaSemana);
      if (!(d.titulo || '').trim()) {
        throw new BadRequestException(`Falta el titulo del ${DIAS_SEMANA[d.diaSemana]}`);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const rutina = dto.id
        ? await tx.routine.update({
            where: { id: dto.id },
            data: { nombre, descripcion: dto.descripcion?.trim() || null },
          })
        : await tx.routine.create({ data: { nombre, descripcion: dto.descripcion?.trim() || null } });

      // Los dias se reescriben completos: es una plantilla chica y asi no hay
      // que conciliar ejercicios movidos de un dia a otro.
      await tx.routineDay.deleteMany({ where: { routineId: rutina.id } });
      for (const d of dto.dias) {
        await tx.routineDay.create({
          data: {
            routineId: rutina.id,
            diaSemana: d.diaSemana,
            titulo: d.titulo.trim(),
            grupos: (d.grupos || []).join(','),
            ejercicios: {
              create: (d.ejercicios || []).map((e, i) => ({
                exerciseId: e.exerciseId,
                series: Math.min(10, Math.max(1, Number(e.series) || 3)),
                repeticiones: String(e.repeticiones || '10').slice(0, 20),
                orden: i,
              })),
            },
          },
        });
      }
      return { id: rutina.id };
    });
  }

  async archivarPlantilla(id: string) {
    await this.prisma.routine.update({ where: { id }, data: { activo: false } });
    return { ok: true };
  }

  // -------------------------------------------------------- asignaciones

  /** Vence las rutinas cuya fecha "hasta" ya paso. */
  private async vencer() {
    await this.prisma.routineAssignment.updateMany({
      where: { estado: 'activa', hasta: { lt: hoyLima() } },
      data: { estado: 'terminada' },
    });
  }

  async asignaciones() {
    await this.vencer();
    const lista = await this.prisma.routineAssignment.findMany({
      where: { estado: { in: ['solicitada', 'activa'] } },
      orderBy: [{ estado: 'desc' }, { createdAt: 'asc' }],
      include: { member: true, routine: true },
    });
    return lista.map((a) => ({
      id: a.id,
      estado: a.estado,
      nota: a.nota,
      desde: a.createdAt,
      hasta: a.hasta,
      rutina: a.routine ? { id: a.routine.id, nombre: a.routine.nombre } : null,
      socio: {
        id: a.member.id,
        nombreCompleto: `${a.member.nombres} ${a.member.apellidos}`,
        dni: a.member.dni,
        inscrito: a.member.createdAt,
      },
    }));
  }

  async asignar(dto: { memberId: string; routineId: string; semanas: number; nota?: string }, staffId: string) {
    const semanas = Math.min(12, Math.max(1, Math.round(Number(dto.semanas) || 4)));
    const [socio, rutina] = await Promise.all([
      this.prisma.member.findUnique({ where: { id: dto.memberId } }),
      this.prisma.routine.findUnique({ where: { id: dto.routineId } }),
    ]);
    if (!socio) throw new NotFoundException('Socio no encontrado');
    if (!rutina || !rutina.activo) throw new NotFoundException('Rutina no encontrada');

    const abierta = await this.prisma.routineAssignment.findFirst({
      where: { memberId: dto.memberId, estado: { in: ['solicitada', 'activa'] } },
    });
    const data = {
      routineId: rutina.id,
      estado: 'activa',
      hasta: sumarDias(hoyLima(), semanas * 7),
      asignadoPor: staffId,
      ...(dto.nota !== undefined ? { nota: dto.nota?.trim() || null } : {}),
    };
    const a = abierta
      ? await this.prisma.routineAssignment.update({ where: { id: abierta.id }, data })
      : await this.prisma.routineAssignment.create({ data: { memberId: dto.memberId, ...data } });
    return { ok: true, id: a.id, hasta: a.hasta };
  }

  async terminar(id: string) {
    await this.prisma.routineAssignment.update({ where: { id }, data: { estado: 'terminada' } });
    return { ok: true };
  }

  // ------------------------------------------------------------- portal

  private async esNuevo(memberId: string) {
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio) return false;
    const reciente = Date.now() - socio.createdAt.getTime() < this.DIAS_NUEVO * 86400000;
    if (reciente) return true;
    const visitas = await this.prisma.checkIn.count({
      where: { memberId, tipo: 'entrada', resultado: 'permitido' },
    });
    return visitas < this.VISITAS_NUEVO;
  }

  /**
   * Lo que el portal necesita: si puede pedir rutina, en que estado esta la
   * suya y que le toca hoy. `hoy` es null si hoy es dia de descanso.
   */
  async miRutina(memberId: string) {
    await this.vencer();
    const a = await this.prisma.routineAssignment.findFirst({
      where: { memberId, estado: { in: ['solicitada', 'activa'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        routine: {
          include: {
            dias: {
              orderBy: { diaSemana: 'asc' },
              include: { ejercicios: { orderBy: { orden: 'asc' }, include: { exercise: true } } },
            },
          },
        },
      },
    });

    if (!a) return { estado: 'ninguna', puedePedir: await this.esNuevo(memberId) };
    if (a.estado === 'solicitada' || !a.routine) {
      return { estado: 'solicitada', puedePedir: false, pedida: a.createdAt };
    }
    const dias = a.routine.dias.map((d) => this.formatoDia(d));
    const hoy = dias.find((d) => d.diaSemana === this.diaSemanaHoy()) ?? null;
    return {
      estado: 'activa',
      puedePedir: false,
      id: a.id,
      rutina: a.routine.nombre,
      nota: a.nota,
      hasta: a.hasta,
      hoy,
      dias,
    };
  }

  async pedir(memberId: string, nota?: string) {
    const abierta = await this.prisma.routineAssignment.findFirst({
      where: { memberId, estado: { in: ['solicitada', 'activa'] } },
    });
    if (abierta) throw new BadRequestException('Ya tienes una rutina pedida o activa');
    if (!(await this.esNuevo(memberId))) {
      throw new BadRequestException(
        'La rutina guiada es para tus primeras semanas. Si la necesitas, pidesela al entrenador en recepcion.',
      );
    }
    await this.prisma.routineAssignment.create({
      data: { memberId, estado: 'solicitada', nota: nota?.trim().slice(0, 200) || null },
    });
    return this.miRutina(memberId);
  }

  async dejar(memberId: string) {
    await this.prisma.routineAssignment.updateMany({
      where: { memberId, estado: { in: ['solicitada', 'activa'] } },
      data: { estado: 'terminada' },
    });
    return { ok: true };
  }
}
