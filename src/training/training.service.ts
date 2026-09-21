import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  diaLimaDe, fechaDesdeTexto, formatoFecha as formatoDia, hoyLima, soloFecha, sumarDias,
} from '../common/fechas';

/** Zonas del portal (mismos valores que usa el mapa del cuerpo). */
export const GRUPOS_VALIDOS = ['pecho', 'espalda', 'core', 'hombro', 'brazo', 'gluteo', 'pierna', 'cardio', 'otros'];

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

  /**
   * Catalogo del gimnasio mas los ejercicios que el socio creo para si. El
   * personal (sin memberId) solo ve el del gimnasio.
   */
  async listarEjercicios(memberId?: string) {
    const lista = await this.prisma.exercise.findMany({
      where: { activo: true, OR: [{ memberId: null }, ...(memberId ? [{ memberId }] : [])] },
      orderBy: [{ grupo: 'asc' }, { nombre: 'asc' }],
    });
    return lista.map((e) => ({ id: e.id, nombre: e.nombre, grupo: e.grupo, propio: !!e.memberId }));
  }

  /** "  press   arnold " -> "Press arnold". Comparar sin tildes ni mayusculas. */
  private limpiarNombre(nombre: string) {
    const limpio = (nombre || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (limpio.length < 3) throw new BadRequestException('El nombre del ejercicio es muy corto');
    return limpio.charAt(0).toUpperCase() + limpio.slice(1);
  }

  private clave(nombre: string) {
    return nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  /**
   * El socio agrega un ejercicio que no esta en el catalogo. Si ya existe con
   * ese nombre (en el catalogo o entre los suyos), devuelve ese en vez de
   * duplicarlo: "press arnold" y "Press Arnold" son lo mismo.
   */
  async crearEjercicio(memberId: string, nombre: string, grupo: string) {
    const limpio = this.limpiarNombre(nombre);
    if (!GRUPOS_VALIDOS.includes(grupo)) throw new BadRequestException('Elige la zona del ejercicio');

    const candidatos = await this.prisma.exercise.findMany({
      where: { OR: [{ memberId: null }, { memberId }] },
    });
    const igual = candidatos.find((e) => this.clave(e.nombre) === this.clave(limpio));
    if (igual && (igual.activo || igual.memberId === memberId)) {
      const e = igual.activo
        ? igual
        : await this.prisma.exercise.update({ where: { id: igual.id }, data: { activo: true, grupo } });
      return { id: e.id, nombre: e.nombre, grupo: e.grupo, propio: !!e.memberId, yaExistia: true };
    }
    const e = await this.prisma.exercise.create({ data: { nombre: limpio, grupo, memberId } });
    return { id: e.id, nombre: e.nombre, grupo: e.grupo, propio: true, yaExistia: false };
  }

  private async ejercicioPropio(memberId: string, id: string) {
    const e = await this.prisma.exercise.findUnique({ where: { id } });
    if (!e || e.memberId !== memberId) throw new ForbiddenException('Solo puedes cambiar los ejercicios que creaste');
    return e;
  }

  async editarEjercicio(memberId: string, id: string, dto: { nombre?: string; grupo?: string }) {
    await this.ejercicioPropio(memberId, id);
    const data: Record<string, string> = {};
    if (dto.nombre !== undefined) data.nombre = this.limpiarNombre(dto.nombre);
    if (dto.grupo !== undefined) {
      if (!GRUPOS_VALIDOS.includes(dto.grupo)) throw new BadRequestException('Zona invalida');
      data.grupo = dto.grupo;
    }
    const e = await this.prisma.exercise.update({ where: { id }, data });
    return { id: e.id, nombre: e.nombre, grupo: e.grupo, propio: true };
  }

  /** Si ya tiene series anotadas se oculta (el historial no se pierde); si no, se borra. */
  async borrarEjercicio(memberId: string, id: string) {
    await this.ejercicioPropio(memberId, id);
    const usado = await this.prisma.workoutSet.count({ where: { exerciseId: id } });
    if (usado) await this.prisma.exercise.update({ where: { id }, data: { activo: false } });
    else await this.prisma.exercise.delete({ where: { id } });
    return { ok: true };
  }

  /** El socio solo puede anotar en ejercicios del gimnasio o en los suyos. */
  private async ejercicioUsable(memberId: string, id: string) {
    const e = await this.prisma.exercise.findUnique({ where: { id } });
    if (!e || (e.memberId && e.memberId !== memberId)) {
      throw new BadRequestException('Ejercicio no encontrado');
    }
    return e;
  }

  // ---------------------------------------------------------- entrenamiento

  async registrar(
    memberId: string,
    dto: {
      fecha?: string;
      exerciseId?: string;
      nombreEjercicio?: string;
      grupo?: string;
      series: { repeticiones: number; pesoKg: number }[];
      nota?: string;
    },
  ) {
    if (!dto.series?.length) throw new BadRequestException('Registra al menos una serie');

    const ejercicio = dto.exerciseId
      ? await this.ejercicioUsable(memberId, dto.exerciseId)
      : await this.crearEjercicio(memberId, dto.nombreEjercicio || '', dto.grupo || 'otros');

    const fecha = fechaDesdeTexto(dto.fecha, hoyLima());
    if (fecha.getTime() > hoyLima().getTime()) {
      throw new BadRequestException('No se puede registrar un entrenamiento futuro');
    }

    // Record: se compara con todo lo anotado antes de estas series.
    const [previo, yaHoy] = await Promise.all([
      this.prisma.workoutSet.aggregate({
        where: { memberId, exerciseId: ejercicio.id },
        _max: { pesoKg: true },
      }),
      this.prisma.workoutSet.count({ where: { memberId, exerciseId: ejercicio.id, fecha } }),
    ]);
    const mejorAnterior = previo._max.pesoKg ?? null;
    const mejorNuevo = Math.max(...dto.series.map((s) => s.pesoKg));

    await this.prisma.workoutSet.createMany({
      data: dto.series.map((s, i) => ({
        memberId,
        exerciseId: ejercicio.id,
        fecha,
        // Si ya anoto series de este ejercicio hoy, se sigue la numeracion.
        serie: yaHoy + i + 1,
        repeticiones: s.repeticiones,
        pesoKg: s.pesoKg,
        nota: i === 0 ? dto.nota || null : null,
      })),
    });

    return {
      ok: true,
      ejercicio: ejercicio.nombre,
      exerciseId: ejercicio.id,
      series: dto.series.length,
      // La primera vez no es record: no hay contra que comparar.
      record: mejorAnterior !== null && mejorAnterior > 0 && mejorNuevo > mejorAnterior,
      mejorAnterior,
      mejorNuevo,
    };
  }

  /**
   * "La ultima vez": las series de la sesion anterior de ese ejercicio, para
   * que el socio sepa con cuanto empezar (como la columna "Previous" de Hevy).
   */
  async ultimaSesion(memberId: string, exerciseId: string) {
    const hoy = hoyLima();
    const anterior = await this.prisma.workoutSet.findFirst({
      where: { memberId, exerciseId, fecha: { lt: hoy } },
      orderBy: { fecha: 'desc' },
    });
    const [series, mejor, deHoy] = await Promise.all([
      anterior
        ? this.prisma.workoutSet.findMany({
            where: { memberId, exerciseId, fecha: anterior.fecha },
            orderBy: [{ serie: 'asc' }, { createdAt: 'asc' }],
          })
        : Promise.resolve([]),
      this.prisma.workoutSet.aggregate({ where: { memberId, exerciseId }, _max: { pesoKg: true } }),
      this.prisma.workoutSet.count({ where: { memberId, exerciseId, fecha: hoy } }),
    ]);
    return {
      dia: anterior ? formatoDia(anterior.fecha) : null,
      series: series.map((s) => ({ repeticiones: s.repeticiones, pesoKg: s.pesoKg })),
      mejorPeso: mejor._max.pesoKg ?? null,
      seriesHoy: deHoy,
    };
  }

  async borrarSerie(memberId: string, id: string) {
    const serie = await this.prisma.workoutSet.findUnique({ where: { id } });
    if (!serie || serie.memberId !== memberId) throw new ForbiddenException('Esa serie no es tuya');
    await this.prisma.workoutSet.delete({ where: { id } });
    return { ok: true };
  }

  // -------------------------------------------------------------- semana

  /** Lunes de la semana de `fecha` (fecha de negocio, medianoche UTC). */
  private lunesDe(fecha: Date) {
    const d = fecha.getUTCDay();
    return sumarDias(fecha, d === 0 ? -6 : 1 - d);
  }

  /**
   * Resumen de una semana, de lunes a domingo: que dias vino, que zonas
   * trabajo, cuantas series por zona (lo que Hevy llama "sets per muscle group")
   * y como le fue contra la semana anterior.
   */
  async semana(memberId: string, desde?: string) {
    const lunes = this.lunesDe(fechaDesdeTexto(desde, hoyLima()));
    const domingo = sumarDias(lunes, 6);
    const lunesAnterior = sumarDias(lunes, -7);
    // Los ingresos son instantes reales: la semana de Lima empieza a las 05:00 UTC.
    const aInstante = (d: Date) => new Date(d.getTime() + 5 * 3600 * 1000);

    const [series, ingresos, anteriores, plan, ingresosAnteriores] = await Promise.all([
      this.prisma.workoutSet.findMany({
        where: { memberId, fecha: { gte: lunes, lte: domingo } },
        include: { exercise: true },
        orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.checkIn.findMany({
        where: {
          memberId,
          tipo: 'entrada',
          resultado: 'permitido',
          timestamp: { gte: aInstante(lunes), lt: aInstante(sumarDias(lunes, 7)) },
        },
        select: { timestamp: true },
      }),
      this.prisma.workoutSet.findMany({
        where: { memberId, fecha: { gte: lunesAnterior, lt: lunes } },
        select: { fecha: true, repeticiones: true, pesoKg: true },
      }),
      this.planSemanal(memberId),
      this.prisma.checkIn.findMany({
        where: {
          memberId,
          tipo: 'entrada',
          resultado: 'permitido',
          timestamp: { gte: aInstante(lunesAnterior), lt: aInstante(lunes) },
        },
        select: { timestamp: true },
      }),
    ]);

    const diasGym = new Set(ingresos.map((i) => diaLimaDe(i.timestamp)));
    const hoy = diaLimaDe(new Date());
    const porGrupo: Record<string, number> = {};
    const dias = Array.from({ length: 7 }, (_, i) => {
      const fecha = sumarDias(lunes, i);
      const clave = formatoDia(fecha);
      const delDia = series.filter((s) => formatoDia(s.fecha) === clave);
      const ejercicios = new Map<string, { nombre: string; grupo: string; series: number }>();
      for (const s of delDia) {
        const e = ejercicios.get(s.exerciseId) ?? { nombre: s.exercise.nombre, grupo: s.exercise.grupo, series: 0 };
        e.series += 1;
        ejercicios.set(s.exerciseId, e);
        porGrupo[s.exercise.grupo] = (porGrupo[s.exercise.grupo] || 0) + 1;
      }
      return {
        fecha: clave,
        diaSemana: i + 1,
        esHoy: clave === hoy,
        futuro: clave > hoy,
        fueAlGym: diasGym.has(clave),
        grupos: Array.from(new Set(delDia.map((s) => s.exercise.grupo))),
        series: delDia.length,
        volumen: Math.round(delDia.reduce((t, s) => t + s.repeticiones * s.pesoKg, 0)),
        ejercicios: Array.from(ejercicios.values()),
        plan: plan[i],
      };
    });

    const resumen = (lista: { fecha: Date; repeticiones: number; pesoKg: number }[], extraDias: Set<string>) => {
      const conSeries = new Set(lista.map((s) => formatoDia(s.fecha)));
      return {
        dias: new Set([...conSeries, ...extraDias]).size,
        series: lista.length,
        volumen: Math.round(lista.reduce((t, s) => t + s.repeticiones * s.pesoKg, 0)),
      };
    };

    return {
      desde: formatoDia(lunes),
      hasta: formatoDia(domingo),
      esActual: formatoDia(lunes) === formatoDia(this.lunesDe(hoyLima())),
      dias,
      total: resumen(series, diasGym),
      anterior: resumen(anteriores, new Set(ingresosAnteriores.map((i) => diaLimaDe(i.timestamp)))),
      seriesPorGrupo: porGrupo,
    };
  }

  // ------------------------------------------------------ plan semanal

  /** Siempre 7 entradas, lunes a domingo. Sin zonas = descanso. */
  async planSemanal(memberId: string) {
    const filas = await this.prisma.weekPlan.findMany({ where: { memberId } });
    return Array.from({ length: 7 }, (_, i) => {
      const f = filas.find((x) => x.diaSemana === i + 1);
      return {
        diaSemana: i + 1,
        titulo: f?.titulo ?? '',
        grupos: f?.grupos ? f.grupos.split(',').filter(Boolean) : [],
      };
    });
  }

  async guardarPlanSemanal(memberId: string, dias: { diaSemana: number; titulo?: string; grupos: string[] }[]) {
    for (const d of dias) {
      if (!Number.isInteger(d.diaSemana) || d.diaSemana < 1 || d.diaSemana > 7) {
        throw new BadRequestException('Dia de la semana invalido');
      }
      if (d.grupos.some((g) => !GRUPOS_VALIDOS.includes(g))) throw new BadRequestException('Zona invalida');
    }
    await this.prisma.$transaction([
      this.prisma.weekPlan.deleteMany({ where: { memberId } }),
      this.prisma.weekPlan.createMany({
        data: dias
          .filter((d) => d.grupos.length || d.titulo?.trim())
          .map((d) => ({
            memberId,
            diaSemana: d.diaSemana,
            titulo: (d.titulo || '').trim().slice(0, 40),
            grupos: d.grupos.join(','),
          })),
      }),
    ]);
    return this.planSemanal(memberId);
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
      const dia = formatoDia(s.fecha);
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
      const dia = formatoDia(s.fecha);
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
      dia: formatoDia(r.fecha),
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
