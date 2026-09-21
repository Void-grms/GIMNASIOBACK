import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { diaLimaDe, fechaDesdeTexto, hoyLima, soloFecha, sumarDias } from '../common/fechas';

/**
 * Progreso del socio: que levanta y cuanto pesa.
 *
 * El peso corporal es informacion de salud, asi que vive detras de un
 * consentimiento aparte del general y el socio lo puede borrar cuando quiera.
 * Los registros son suyos: el personal del gimnasio no los ve.
 */
@Injectable()
export class TrainingService {
  constructor(private prisma: PrismaService) {}

  // ------------------------------------------------------------- ejercicios

  listarEjercicios() {
    return this.prisma.exercise.findMany({
      where: { activo: true },
      orderBy: [{ grupo: 'asc' }, { nombre: 'asc' }],
    });
  }

  /** Si el socio entrena algo que no esta en el catalogo, se agrega. */
  async ejercicioPorNombre(nombre: string) {
    const limpio = nombre.trim();
    if (limpio.length < 2) throw new BadRequestException('Nombre de ejercicio muy corto');
    const existe = await this.prisma.exercise.findUnique({ where: { nombre: limpio } });
    return existe ?? this.prisma.exercise.create({ data: { nombre: limpio, grupo: 'otros' } });
  }

  // ---------------------------------------------------------- entrenamiento

  async registrar(
    memberId: string,
    dto: {
      fecha?: string;
      exerciseId?: string;
      nombreEjercicio?: string;
      series: { repeticiones: number; pesoKg: number }[];
      nota?: string;
    },
  ) {
    if (!dto.series?.length) throw new BadRequestException('Registra al menos una serie');

    const ejercicio = dto.exerciseId
      ? await this.prisma.exercise.findUnique({ where: { id: dto.exerciseId } })
      : await this.ejercicioPorNombre(dto.nombreEjercicio || '');
    if (!ejercicio) throw new BadRequestException('Ejercicio no encontrado');

    const fecha = fechaDesdeTexto(dto.fecha, hoyLima());
    if (fecha.getTime() > hoyLima().getTime()) {
      throw new BadRequestException('No se puede registrar un entrenamiento futuro');
    }

    await this.prisma.workoutSet.createMany({
      data: dto.series.map((s, i) => ({
        memberId,
        exerciseId: ejercicio.id,
        fecha,
        serie: i + 1,
        repeticiones: s.repeticiones,
        pesoKg: s.pesoKg,
        nota: i === 0 ? dto.nota || null : null,
      })),
    });

    return { ok: true, ejercicio: ejercicio.nombre, series: dto.series.length };
  }

  async historial(memberId: string, desde?: string, hasta?: string) {
    const d = fechaDesdeTexto(desde, sumarDias(hoyLima(), -60));
    const h = fechaDesdeTexto(hasta, hoyLima());

    const series = await this.prisma.workoutSet.findMany({
      where: { memberId, fecha: { gte: d, lte: h } },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'asc' }],
      include: { exercise: true },
    });

    // Se agrupa por dia y ejercicio, que es como lo lee una persona.
    const dias = new Map<string, Map<string, any>>();
    for (const s of series) {
      const dia = diaLimaDe(s.fecha);
      if (!dias.has(dia)) dias.set(dia, new Map());
      const porEjercicio = dias.get(dia)!;
      if (!porEjercicio.has(s.exerciseId)) {
        porEjercicio.set(s.exerciseId, {
          ejercicio: s.exercise.nombre,
          grupo: s.exercise.grupo,
          exerciseId: s.exerciseId,
          series: [],
        });
      }
      porEjercicio.get(s.exerciseId).series.push({
        id: s.id,
        serie: s.serie,
        repeticiones: s.repeticiones,
        pesoKg: s.pesoKg,
      });
    }

    return Array.from(dias.entries()).map(([dia, porEjercicio]) => ({
      dia,
      ejercicios: Array.from(porEjercicio.values()),
      volumen: Array.from(porEjercicio.values()).reduce(
        (t: number, e: any) =>
          t + e.series.reduce((x: number, s: any) => x + s.repeticiones * s.pesoKg, 0),
        0,
      ),
    }));
  }

  /**
   * Progreso de un ejercicio. Se sigue el mejor peso del dia y una estimacion
   * de una repeticion maxima con la formula de Epley, que es la que permite
   * comparar un dia de 5 repeticiones con uno de 10.
   */
  async progreso(memberId: string, exerciseId: string) {
    const series = await this.prisma.workoutSet.findMany({
      where: { memberId, exerciseId },
      orderBy: { fecha: 'asc' },
      include: { exercise: true },
    });
    if (series.length === 0) return { ejercicio: null, puntos: [] };

    const porDia = new Map<string, any>();
    for (const s of series) {
      const dia = diaLimaDe(s.fecha);
      const unaRm = s.pesoKg * (1 + s.repeticiones / 30);
      const actual = porDia.get(dia) ?? { dia, mejorPeso: 0, unaRm: 0, volumen: 0, series: 0 };
      actual.mejorPeso = Math.max(actual.mejorPeso, s.pesoKg);
      actual.unaRm = Math.max(actual.unaRm, Math.round(unaRm * 10) / 10);
      actual.volumen += s.repeticiones * s.pesoKg;
      actual.series += 1;
      porDia.set(dia, actual);
    }

    const puntos = Array.from(porDia.values());
    const primero = puntos[0];
    const ultimo = puntos[puntos.length - 1];

    return {
      ejercicio: series[0].exercise.nombre,
      puntos,
      mejora:
        primero.mejorPeso > 0
          ? Math.round(((ultimo.mejorPeso - primero.mejorPeso) / primero.mejorPeso) * 100)
          : 0,
      mejorMarca: Math.max(...puntos.map((p) => p.mejorPeso)),
    };
  }

  /** Los ejercicios que el socio ya registro, para el selector de progreso. */
  async misEjercicios(memberId: string) {
    const series = await this.prisma.workoutSet.findMany({
      where: { memberId },
      distinct: ['exerciseId'],
      include: { exercise: true },
      orderBy: { fecha: 'desc' },
    });
    return series.map((s) => ({ id: s.exerciseId, nombre: s.exercise.nombre }));
  }

  // -------------------------------------------------------- peso corporal

  /** El peso corporal solo se guarda si el socio consintio ese tratamiento. */
  private async exigirConsentimientoSalud(memberId: string) {
    const consentimiento = await this.prisma.consent.findFirst({
      where: { memberId, tipo: 'salud', aceptado: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!consentimiento) {
      throw new ForbiddenException(
        'Para guardar tu peso necesitamos tu autorizacion: es informacion de salud.',
      );
    }
  }

  async registrarPeso(
    memberId: string,
    dto: { fecha?: string; pesoKg: number; cinturaCm?: number; nota?: string },
  ) {
    await this.exigirConsentimientoSalud(memberId);

    if (dto.pesoKg < 20 || dto.pesoKg > 400) {
      throw new BadRequestException('Ese peso no parece correcto');
    }
    const fecha = fechaDesdeTexto(dto.fecha, hoyLima());
    if (fecha.getTime() > hoyLima().getTime()) {
      throw new BadRequestException('No se puede anotar un peso futuro');
    }

    // Un registro por dia: si se pesa dos veces, queda el ultimo.
    return this.prisma.bodyLog.upsert({
      where: { memberId_fecha: { memberId, fecha } },
      update: { pesoKg: dto.pesoKg, cinturaCm: dto.cinturaCm ?? null, nota: dto.nota || null },
      create: {
        memberId,
        fecha,
        pesoKg: dto.pesoKg,
        cinturaCm: dto.cinturaCm ?? null,
        nota: dto.nota || null,
      },
    });
  }

  async pesos(memberId: string, dias = 180) {
    const desde = sumarDias(hoyLima(), -dias);
    const registros = await this.prisma.bodyLog.findMany({
      where: { memberId, fecha: { gte: desde } },
      orderBy: { fecha: 'asc' },
    });

    const puntos = registros.map((r) => ({
      dia: diaLimaDe(r.fecha),
      pesoKg: r.pesoKg,
      cinturaCm: r.cinturaCm,
      id: r.id,
      nota: r.nota,
    }));

    return {
      puntos,
      actual: puntos.at(-1)?.pesoKg ?? null,
      variacion:
        puntos.length > 1
          ? Math.round((puntos.at(-1)!.pesoKg - puntos[0].pesoKg) * 10) / 10
          : 0,
    };
  }

  async borrarPeso(memberId: string, id: string) {
    const registro = await this.prisma.bodyLog.findUnique({ where: { id } });
    if (!registro || registro.memberId !== memberId) {
      throw new ForbiddenException('Ese registro no es tuyo');
    }
    await this.prisma.bodyLog.delete({ where: { id } });
    return { ok: true };
  }

  /** Revocar el consentimiento borra lo que se guardo con el. */
  async revocarSalud(memberId: string) {
    await this.prisma.bodyLog.deleteMany({ where: { memberId } });
    await this.prisma.consent.create({
      data: {
        memberId,
        tipo: 'salud',
        version: '1.0',
        aceptado: false,
        texto: 'Revocacion del consentimiento para registrar peso y medidas',
        origen: 'portal',
      },
    });
    return { ok: true, mensaje: 'Borramos tus registros de peso y medidas.' };
  }

  async estadoConsentimientoSalud(memberId: string) {
    const ultimo = await this.prisma.consent.findFirst({
      where: { memberId, tipo: 'salud' },
      orderBy: { createdAt: 'desc' },
    });
    return { aceptado: !!ultimo?.aceptado };
  }

  async aceptarSalud(memberId: string, texto: string) {
    await this.prisma.consent.create({
      data: { memberId, tipo: 'salud', version: '1.0', aceptado: true, texto, origen: 'portal' },
    });
    return { aceptado: true };
  }
}
