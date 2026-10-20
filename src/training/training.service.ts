import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  diaLimaDe, fechaDesdeTexto, formatoFecha as formatoDia, hoyLima, soloFecha, sumarDias,
} from '../common/fechas';

/** Zonas del portal (mismos valores que usa el mapa del cuerpo). */
export const GRUPOS_VALIDOS = ['pecho', 'espalda', 'core', 'hombro', 'brazo', 'gluteo', 'pierna', 'cardio', 'otros'];

/** Los historicos conservan sus columnas: solo se interpreta su unidad al leer. */
export const SOLO_FUERZA: Prisma.WorkoutSetWhereInput = {
  deletedAt: null,
  OR: [{ tipo: 'fuerza' }, { tipo: null, exercise: { grupo: { not: 'cardio' } } }],
};

type SerieEntrada = { repeticiones?: number; pesoKg?: number; duracionMinutos?: number; nivel?: number };
const esCardio = (s: { tipo?: string; exercise?: { grupo: string } }) => s.tipo === 'cardio' || (!s.tipo && s.exercise?.grupo === 'cardio');

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
  async crearEjercicio(memberId: string, nombre: string, grupo: string, db: Prisma.TransactionClient = this.prisma) {
    const limpio = this.limpiarNombre(nombre);
    if (!GRUPOS_VALIDOS.includes(grupo)) throw new BadRequestException('Elige la zona del ejercicio');

    const candidatos = await db.exercise.findMany({
      where: { OR: [{ memberId: null }, { memberId }] },
    });
    const igual = candidatos.find((e) => this.clave(e.nombre) === this.clave(limpio));
    if (igual && (igual.activo || igual.memberId === memberId)) {
      const e = igual.activo
        ? igual
        : await db.exercise.update({ where: { id: igual.id }, data: { activo: true, grupo } });
      return { id: e.id, nombre: e.nombre, grupo: e.grupo, propio: !!e.memberId, yaExistia: true };
    }
    const e = await db.exercise.create({ data: { nombre: limpio, grupo, memberId } });
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
  private async ejercicioUsable(memberId: string, id: string, db: Prisma.TransactionClient = this.prisma) {
    const e = await db.exercise.findUnique({ where: { id } });
    if (!e || (e.memberId && e.memberId !== memberId)) {
      throw new BadRequestException('Ejercicio no encontrado');
    }
    return e;
  }

  // ---------------------------------------------------------- entrenamiento

  /** UPDATE de cero bloquea al socio en la base, incluso entre replicas. */
  private async conEntrenamientoBloqueado<T>(memberId: string, trabajo: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let intento = 0; intento < 3; intento++) {
      try {
        return await this.prisma.$transaction(async tx => {
          // SQL parametrizado portable: toma el bloqueo sin disparar @updatedAt de Prisma.
          const bloqueo = await tx.$executeRaw`UPDATE "Member" SET "portalVersion" = "portalVersion" WHERE "id" = ${memberId}`;
          if (!bloqueo) throw new NotFoundException('Socio no encontrado');
          return trabajo(tx);
        }, { maxWait: 10000, timeout: 10000 });
      } catch (error) {
        if (['P2034', 'P1008'].includes(error?.code) && intento < 2) {
          await new Promise(resolve => setTimeout(resolve, (intento + 1) * 25));
          continue;
        }
        if (['P2034', 'P1008', 'P2028'].includes(error?.code)) {
          throw new ServiceUnavailableException('No se pudo guardar. Conserva tu serie y vuelve a intentarlo.');
        }
        throw error;
      }
    }
  }

  private normalizarSerie(s: SerieEntrada, cardio: boolean) {
    if (cardio) {
      const duracionMinutos = s.duracionMinutos ?? s.repeticiones;
      const nivel = s.nivel ?? s.pesoKg ?? 0;
      if (!Number.isFinite(duracionMinutos) || duracionMinutos < 0.1 || duracionMinutos > 360 ||
          !Number.isFinite(nivel) || nivel < 0 || nivel > 100) {
        throw new BadRequestException('Indica entre 0.1 y 360 minutos y un nivel de 0 a 100');
      }
      // Columnas legacy para clientes anteriores; las metricas nuevas solo usan su unidad correcta.
      return { tipo: 'cardio', duracionMinutos, nivel, repeticiones: Math.max(1, Math.round(duracionMinutos)), pesoKg: nivel };
    }
    if (!Number.isInteger(s.repeticiones) || s.repeticiones < 1 || s.repeticiones > 200 ||
        !Number.isFinite(s.pesoKg) || s.pesoKg < 0 || s.pesoKg > 500 || s.duracionMinutos !== undefined || s.nivel !== undefined) {
      throw new BadRequestException('Indica repeticiones de 1 a 200 y peso de 0 a 500 kg');
    }
    return { tipo: 'fuerza', repeticiones: s.repeticiones, pesoKg: s.pesoKg, duracionMinutos: null, nivel: null };
  }

  private seriePublica(s: any) {
    const cardio = esCardio(s);
    return {
      id: s.id, exerciseId: s.exerciseId, ejercicio: s.exercise?.nombre,
      grupo: s.exercise?.grupo, serie: s.serie, repeticiones: s.repeticiones, pesoKg: s.pesoKg,
      tipo: cardio ? 'cardio' : 'fuerza',
      duracionMinutos: cardio ? s.duracionMinutos ?? s.repeticiones : null,
      nivel: cardio ? s.nivel ?? s.pesoKg : null,
      sessionId: s.sessionId, deletedAt: s.deletedAt, createdAt: s.createdAt,
    };
  }

  private async respuestaOperacion(db: Prisma.TransactionClient, op: { id: string; responseJson: string }, repetida: boolean) {
    const sets = await db.workoutSet.findMany({ where: { operationId: op.id }, include: { exercise: true }, orderBy: { serie: 'asc' } });
    return { ...JSON.parse(op.responseJson), sets: sets.map(s => this.seriePublica(s)), idempotente: repetida };
  }

  async registrar(memberId: string, dto: {
    fecha?: string; exerciseId?: string; nombreEjercicio?: string; grupo?: string;
    series: SerieEntrada[]; nota?: string; operationId?: string; sessionId?: string;
  }) {
    if (!dto.series?.length || dto.series.length > 20) throw new BadRequestException('Registra de 1 a 20 series');
    const operationId = dto.operationId || randomUUID(); // Compatibilidad con clientes anteriores.
    const payloadHash = createHash('sha256').update(JSON.stringify({
      fecha: dto.fecha ?? null, exerciseId: dto.exerciseId ?? null,
      nombreEjercicio: dto.nombreEjercicio ?? null, grupo: dto.grupo ?? null,
      series: dto.series.map(s => ({ repeticiones: s.repeticiones ?? null, pesoKg: s.pesoKg ?? null, duracionMinutos: s.duracionMinutos ?? null, nivel: s.nivel ?? null })),
      nota: dto.nota ?? null, sessionId: dto.sessionId ?? null,
    })).digest('hex');
    return this.conEntrenamientoBloqueado(memberId, async tx => {
      const existente = await tx.workoutOperation.findUnique({ where: { memberId_operationId: { memberId, operationId } } });
      if (existente) {
        if (existente.payloadHash !== payloadHash) throw new ConflictException('Esta operacion ya se guardo con otros datos');
        return this.respuestaOperacion(tx, existente, true);
      }
      let fecha = fechaDesdeTexto(dto.fecha, hoyLima());
      if (dto.fecha && (formatoDia(fecha) !== dto.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(dto.fecha))) throw new BadRequestException('Fecha invalida');
      if (dto.sessionId) {
        const session = await tx.workoutSession.findFirst({ where: { id: dto.sessionId, memberId } });
        if (!session) throw new ForbiddenException('Esta sesion no es tuya');
        if (session.endedAt) throw new ConflictException('El entrenamiento ya finalizo');
        if (dto.fecha && formatoDia(session.fecha) !== dto.fecha) throw new BadRequestException('La fecha no coincide con tu entrenamiento');
        fecha = session.fecha;
      }
      if (fecha.getTime() > hoyLima().getTime()) throw new BadRequestException('No se puede registrar un entrenamiento futuro');
      const ejercicio = dto.exerciseId
        ? await this.ejercicioUsable(memberId, dto.exerciseId, tx)
        : await this.crearEjercicio(memberId, dto.nombreEjercicio || '', dto.grupo || 'otros', tx);
      if ('activo' in ejercicio && !ejercicio.activo) throw new BadRequestException('El ejercicio esta archivado');
      const cardio = ejercicio.grupo === 'cardio';
      const entradas = dto.series.map(s => this.normalizarSerie(s, cardio));
      const [previo, ultima] = await Promise.all([
        cardio ? null : tx.workoutSet.aggregate({ where: { memberId, exerciseId: ejercicio.id, ...SOLO_FUERZA }, _max: { pesoKg: true } }),
        tx.workoutSet.aggregate({ where: { memberId, exerciseId: ejercicio.id, fecha }, _max: { serie: true } }),
      ]);
      const mejorAnterior = previo?._max.pesoKg ?? null;
      const mejorNuevo = cardio ? null : Math.max(...entradas.map(s => s.pesoKg));
      const respuesta = { ok: true, ejercicio: ejercicio.nombre, exerciseId: ejercicio.id, series: entradas.length,
        record: !cardio && mejorAnterior !== null && mejorAnterior > 0 && mejorNuevo > mejorAnterior,
        mejorAnterior, mejorNuevo, tipo: cardio ? 'cardio' : 'fuerza', operationId };
      const op = await tx.workoutOperation.create({ data: { memberId, operationId, payloadHash, responseJson: JSON.stringify(respuesta) } });
      await tx.workoutSet.createMany({ data: entradas.map((s, i) => ({ ...s, memberId, exerciseId: ejercicio.id, fecha,
        serie: (ultima._max.serie ?? 0) + i + 1, nota: i === 0 ? dto.nota || null : null,
        sessionId: dto.sessionId ?? null, operationId: op.id,
      })) });
      return this.respuestaOperacion(tx, op, false);
    });
  }

  private sesionPublica(session: any) {
    return { id: session.id, titulo: session.titulo, fecha: formatoDia(session.fecha),
      startedAt: session.startedAt, endedAt: session.endedAt,
      duracionSegundos: Math.max(0, Math.round(((session.endedAt ?? new Date()).getTime() - session.startedAt.getTime()) / 1000)),
      series: (session.series ?? []).map(s => this.seriePublica(s)) };
  }

  private readonly incluirSesion = { series: { where: { deletedAt: null }, include: { exercise: true }, orderBy: { createdAt: 'asc' as const } } };

  async sesionActiva(memberId: string) {
    const session = await this.prisma.workoutSession.findUnique({ where: { activeMemberId: memberId }, include: this.incluirSesion });
    return session ? this.sesionPublica(session) : null;
  }

  async sesionEntrenamiento(memberId: string, id: string) {
    const session = await this.prisma.workoutSession.findFirst({ where: { memberId, id }, include: this.incluirSesion });
    if (!session) throw new ForbiddenException('Esta sesion no es tuya');
    return this.sesionPublica(session);
  }

  async iniciarSesion(memberId: string, dto: { operationId: string; titulo?: string }) {
    return this.conEntrenamientoBloqueado(memberId, async tx => {
      const op = await tx.workoutOperation.findUnique({ where: { memberId_operationId: { memberId, operationId: dto.operationId } } });
      if (op) {
        if (op.payloadHash !== 'session-start') throw new ConflictException('Esta operacion ya se utilizo');
        const previo = await tx.workoutSession.findFirst({ where: { id: JSON.parse(op.responseJson).sessionId, memberId }, include: this.incluirSesion });
        if (!previo) throw new NotFoundException('Entrenamiento no encontrado');
        return this.sesionPublica(previo);
      }
      const active = await tx.workoutSession.findUnique({ where: { activeMemberId: memberId }, include: this.incluirSesion });
      if (active) {
        await tx.workoutOperation.create({ data: { memberId, operationId: dto.operationId, payloadHash: 'session-start', responseJson: JSON.stringify({ sessionId: active.id }) } });
        return this.sesionPublica(active);
      }
      const session = await tx.workoutSession.create({ data: { memberId, activeMemberId: memberId,
        operationId: dto.operationId, titulo: dto.titulo?.trim().slice(0, 80) || 'Mi entrenamiento', fecha: hoyLima() }, include: this.incluirSesion });
      await tx.workoutOperation.create({ data: { memberId, operationId: dto.operationId, payloadHash: 'session-start', responseJson: JSON.stringify({ sessionId: session.id }) } });
      return this.sesionPublica(session);
    });
  }

  async finalizarSesion(memberId: string, id: string) {
    return this.conEntrenamientoBloqueado(memberId, async tx => {
      const session = await tx.workoutSession.findFirst({ where: { id, memberId }, include: this.incluirSesion });
      if (!session) throw new ForbiddenException('Esta sesion no es tuya');
      if (session.endedAt) return this.sesionPublica(session);
      const final = await tx.workoutSession.update({ where: { id }, data: { endedAt: new Date(), activeMemberId: null }, include: this.incluirSesion });
      return this.sesionPublica(final);
    });
  }

  async editarSerie(memberId: string, id: string, dto: SerieEntrada) {
    return this.conEntrenamientoBloqueado(memberId, async tx => {
      const s = await tx.workoutSet.findFirst({ where: { id, memberId, deletedAt: null }, include: { exercise: true } });
      if (!s) throw new ForbiddenException('Esa serie no es tuya o fue eliminada');
      if (Object.keys(dto).length === 0) throw new BadRequestException('Indica los datos de la serie');
      const cardio = esCardio(s);
      const normalizada = this.normalizarSerie(cardio
        ? { duracionMinutos: dto.duracionMinutos ?? dto.repeticiones ?? s.duracionMinutos ?? s.repeticiones, nivel: dto.nivel ?? dto.pesoKg ?? s.nivel ?? s.pesoKg }
        : { repeticiones: dto.repeticiones ?? s.repeticiones, pesoKg: dto.pesoKg ?? s.pesoKg, duracionMinutos: dto.duracionMinutos, nivel: dto.nivel }, cardio);
      const guardada = await tx.workoutSet.update({ where: { id }, data: normalizada, include: { exercise: true } });
      return this.seriePublica(guardada);
    });
  }

  /**
   * "La ultima vez": las series de la sesion anterior de ese ejercicio, para
   * que el socio sepa con cuanto empezar (como la columna "Previous" de Hevy).
   */
  async ultimaSesion(memberId: string, exerciseId: string) {
    const ejercicio = await this.ejercicioUsable(memberId, exerciseId);
    const hoy = hoyLima();
    const anterior = await this.prisma.workoutSet.findFirst({
      where: { memberId, exerciseId, deletedAt: null, fecha: { lt: hoy } },
      orderBy: { fecha: 'desc' },
    });
    const [series, mejor, deHoy, nota] = await Promise.all([
      anterior
        ? this.prisma.workoutSet.findMany({
            where: { memberId, exerciseId, deletedAt: null, fecha: anterior.fecha },
            orderBy: [{ serie: 'asc' }, { createdAt: 'asc' }],
          })
        : Promise.resolve([]),
      this.prisma.workoutSet.aggregate({ where: { memberId, exerciseId, ...SOLO_FUERZA }, _max: { pesoKg: true } }),
      this.prisma.workoutSet.count({ where: { memberId, exerciseId, deletedAt: null, fecha: hoy } }),
      this.prisma.exerciseNote.findUnique({ where: { memberId_exerciseId: { memberId, exerciseId } } }),
    ]);
    return {
      dia: anterior ? formatoDia(anterior.fecha) : null,
      series: series.map((s) => this.seriePublica({ ...s, exercise: ejercicio })),
      mejorPeso: mejor._max.pesoKg ?? null,
      seriesHoy: deHoy,
      nota: nota?.nota ?? '',
    };
  }

  // ------------------------------------------------------------ notas

  /** Nota fija del socio sobre un ejercicio. Vacia = se borra. */
  async guardarNota(memberId: string, exerciseId: string, nota: string) {
    await this.ejercicioUsable(memberId, exerciseId);
    const limpia = (nota || '').trim().replace(/\s+/g, ' ').slice(0, 140);
    if (!limpia) {
      await this.prisma.exerciseNote.deleteMany({ where: { memberId, exerciseId } });
      return { nota: '' };
    }
    const n = await this.prisma.exerciseNote.upsert({
      where: { memberId_exerciseId: { memberId, exerciseId } },
      update: { nota: limpia },
      create: { memberId, exerciseId, nota: limpia },
    });
    return { nota: n.nota };
  }

  // -------------------------------------------------------- plantillas

  private readonly MAX_PLANTILLAS = 20;

  async plantillas(memberId: string) {
    const [lista, notas] = await Promise.all([
      this.prisma.sessionTemplate.findMany({
        where: { memberId },
        orderBy: { updatedAt: 'desc' },
        include: { items: { orderBy: { orden: 'asc' }, include: { exercise: true } } },
      }),
      this.prisma.exerciseNote.findMany({ where: { memberId } }),
    ]);
    const notaDe = new Map(notas.map((n) => [n.exerciseId, n.nota]));
    return lista.map((t) => ({
      id: t.id,
      nombre: t.nombre,
      grupos: Array.from(new Set(t.items.map((i) => i.exercise.grupo))),
      items: t.items
        // Un ejercicio propio que el socio quito deja de aparecer en la plantilla.
        .filter((i) => i.exercise.activo)
        .map((i) => ({
          exerciseId: i.exerciseId,
          nombre: i.exercise.nombre,
          grupo: i.exercise.grupo,
          series: i.series,
          repeticiones: i.repeticiones,
          nota: notaDe.get(i.exerciseId) ?? '',
        })),
    }));
  }

  private async validarItems(memberId: string, items: { exerciseId: string; series: number; repeticiones: string }[]) {
    if (!items?.length) throw new BadRequestException('La plantilla necesita al menos un ejercicio');
    if (items.length > 20) throw new BadRequestException('Maximo 20 ejercicios por plantilla');
    for (const i of items) await this.ejercicioUsable(memberId, i.exerciseId);
    return items.map((i, orden) => ({
      exerciseId: i.exerciseId,
      series: Math.min(10, Math.max(1, Math.round(Number(i.series) || 3))),
      repeticiones: String(i.repeticiones || '10').trim().slice(0, 20) || '10',
      orden,
    }));
  }

  private nombrePlantilla(nombre: string) {
    const limpio = (nombre || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (limpio.length < 2) throw new BadRequestException('Ponle un nombre a la plantilla');
    return limpio;
  }

  async crearPlantilla(
    memberId: string,
    dto: { nombre: string; items: { exerciseId: string; series: number; repeticiones: string }[] },
  ) {
    const total = await this.prisma.sessionTemplate.count({ where: { memberId } });
    if (total >= this.MAX_PLANTILLAS) {
      throw new BadRequestException(`Puedes guardar hasta ${this.MAX_PLANTILLAS} plantillas. Borra alguna que no uses.`);
    }
    const items = await this.validarItems(memberId, dto.items);
    const t = await this.prisma.sessionTemplate.create({
      data: { memberId, nombre: this.nombrePlantilla(dto.nombre), items: { create: items } },
    });
    return { id: t.id };
  }

  private async plantillaPropia(memberId: string, id: string) {
    const t = await this.prisma.sessionTemplate.findUnique({ where: { id } });
    if (!t || t.memberId !== memberId) throw new ForbiddenException('Esa plantilla no es tuya');
    return t;
  }

  async editarPlantilla(
    memberId: string,
    id: string,
    dto: { nombre: string; items: { exerciseId: string; series: number; repeticiones: string }[] },
  ) {
    await this.plantillaPropia(memberId, id);
    const items = await this.validarItems(memberId, dto.items);
    await this.prisma.$transaction([
      this.prisma.sessionTemplateItem.deleteMany({ where: { templateId: id } }),
      this.prisma.sessionTemplate.update({
        where: { id },
        data: { nombre: this.nombrePlantilla(dto.nombre), items: { create: items } },
      }),
    ]);
    return { id };
  }

  async borrarPlantilla(memberId: string, id: string) {
    await this.plantillaPropia(memberId, id);
    await this.prisma.sessionTemplate.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * "Guardar lo de hoy como plantilla": toma los ejercicios anotados ese dia,
   * en el orden en que se hicieron, con sus series y las repeticiones de la
   * primera serie.
   */
  async plantillaDesdeDia(memberId: string, nombre: string, fecha?: string) {
    const dia = fechaDesdeTexto(fecha, hoyLima());
    const series = await this.prisma.workoutSet.findMany({
      where: { memberId, deletedAt: null, fecha: dia },
      orderBy: { createdAt: 'asc' },
    });
    if (!series.length) throw new BadRequestException('Ese dia no tiene ejercicios anotados');
    const porEjercicio = new Map<string, { exerciseId: string; series: number; repeticiones: string }>();
    for (const s of series) {
      const e = porEjercicio.get(s.exerciseId);
      if (e) e.series += 1;
      else porEjercicio.set(s.exerciseId, { exerciseId: s.exerciseId, series: 1, repeticiones: String(s.repeticiones) });
    }
    return this.crearPlantilla(memberId, { nombre, items: Array.from(porEjercicio.values()) });
  }

  async borrarSerie(memberId: string, id: string) {
    return this.conEntrenamientoBloqueado(memberId, async tx => {
      const serie = await tx.workoutSet.findFirst({ where: { id, memberId } });
      if (!serie) throw new ForbiddenException('Esa serie no es tuya');
      if (!serie.deletedAt) await tx.workoutSet.update({ where: { id }, data: { deletedAt: new Date() } });
      return { ok: true };
    });
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
        where: { memberId, deletedAt: null, fecha: { gte: lunes, lte: domingo } },
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
        where: { memberId, deletedAt: null, fecha: { gte: lunesAnterior, lt: lunes } },
        include: { exercise: true },
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
        volumen: Math.round(delDia.reduce((t, s) => t + (esCardio(s) ? 0 : s.repeticiones * s.pesoKg), 0)),
        ejercicios: Array.from(ejercicios.values()),
        plan: plan[i],
      };
    });

    const resumen = (lista: { fecha: Date; repeticiones: number; pesoKg: number; tipo?: string; exercise?: { grupo: string } }[], extraDias: Set<string>) => {
      const conSeries = new Set(lista.map((s) => formatoDia(s.fecha)));
      return {
        dias: new Set([...conSeries, ...extraDias]).size,
        series: lista.length,
        volumen: Math.round(lista.reduce((t, s) => t + (esCardio(s) ? 0 : s.repeticiones * s.pesoKg), 0)),
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

  async historial(memberId: string, desde?: string, hasta?: string, pagina?: string, limite?: string) {
    const d = fechaDesdeTexto(desde, sumarDias(hoyLima(), -60));
    const h = fechaDesdeTexto(hasta, hoyLima());
    if (h.getTime() < d.getTime() || h.getTime() - d.getTime() > 366 * 86400000) throw new BadRequestException('Consulta un periodo de hasta un ano');
    const page = Number(pagina ?? 1), size = Number(limite ?? 20);
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(size) || size < 1 || size > 31) throw new BadRequestException('Pagina o limite invalido');
    // Pagina por dias completos: una serie nunca se corta entre dos paginas.
    const fechas = await this.prisma.workoutSet.groupBy({
      by: ['fecha'], where: { memberId, deletedAt: null, fecha: { gte: d, lte: h } },
      orderBy: { fecha: 'desc' }, skip: (page - 1) * size, take: size,
    });
    const series = fechas.length ? await this.prisma.workoutSet.findMany({
      where: { memberId, deletedAt: null, fecha: { in: fechas.map(f => f.fecha) } },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], include: { exercise: true },
    }) : [];
    const dias = new Map<string, Map<string, any>>();
    for (const s of series) {
      const dia = formatoDia(s.fecha);
      if (!dias.has(dia)) dias.set(dia, new Map());
      const porEjercicio = dias.get(dia)!;
      if (!porEjercicio.has(s.exerciseId)) porEjercicio.set(s.exerciseId, { ejercicio: s.exercise.nombre, grupo: s.exercise.grupo, exerciseId: s.exerciseId, tipo: esCardio(s) ? 'cardio' : 'fuerza', series: [] });
      porEjercicio.get(s.exerciseId).series.push(this.seriePublica(s));
    }
    return Array.from(dias.entries()).map(([dia, porEjercicio]) => ({
      dia, ejercicios: Array.from(porEjercicio.values()),
      volumen: Array.from(porEjercicio.values()).reduce((t: number, e: any) => t + e.series.reduce((x: number, s: any) => x + (s.tipo === 'cardio' ? 0 : s.repeticiones * s.pesoKg), 0), 0),
      minutosCardio: Array.from(porEjercicio.values()).reduce((t: number, e: any) => t + e.series.reduce((x: number, s: any) => x + (s.tipo === 'cardio' ? s.duracionMinutos : 0), 0), 0),
    }));
  }

  /** Ventana acotada de entrenamiento; cardio usa minutos, nunca kilos ni 1RM. */
  async progreso(memberId: string, exerciseId: string, semanas?: string) {
    const periodo = Number(semanas ?? 8);
    if (![4, 8, 12].includes(periodo)) throw new BadRequestException('Elige 4, 8 o 12 semanas');
    const ejercicio = await this.ejercicioUsable(memberId, exerciseId);
    const desde = sumarDias(hoyLima(), 1 - periodo * 7);
    const series = await this.prisma.workoutSet.findMany({
      where: { memberId, exerciseId, deletedAt: null, fecha: { gte: desde, lte: hoyLima() } },
      orderBy: { fecha: 'asc' }, include: { exercise: true },
    });
    const cardio = ejercicio.grupo === 'cardio';
    const porDia = new Map<string, any>();
    for (const s of series) {
      const dia = formatoDia(s.fecha);
      // Una reclasificacion del catalogo no convierte kilos guardados como fuerza a cardio.
      if (esCardio(s) !== cardio) continue;
      if (cardio) {
        const actual = porDia.get(dia) ?? { dia, minutos: 0, nivel: 0, series: 0, mejorPeso: 0, unaRm: 0, volumen: 0 };
        actual.minutos += s.duracionMinutos ?? s.repeticiones;
        actual.nivel = Math.max(actual.nivel, s.nivel ?? s.pesoKg);
        actual.series++;
        porDia.set(dia, actual);
      } else {
        const actual = porDia.get(dia) ?? { dia, mejorPeso: 0, unaRm: 0, volumen: 0, series: 0 };
        actual.mejorPeso = Math.max(actual.mejorPeso, s.pesoKg);
        actual.unaRm = Math.max(actual.unaRm, Math.round(s.pesoKg * (1 + s.repeticiones / 30) * 10) / 10);
        actual.volumen += s.repeticiones * s.pesoKg;
        actual.series++;
        porDia.set(dia, actual);
      }
    }
    const puntos = Array.from(porDia.values());
    return { ejercicio: ejercicio.nombre, tipo: cardio ? 'cardio' : 'fuerza', semanas: periodo, desde: formatoDia(desde),
      puntos, mejora: !cardio && puntos[0]?.mejorPeso > 0 ? Math.round(((puntos.at(-1).mejorPeso - puntos[0].mejorPeso) / puntos[0].mejorPeso) * 100) : 0,
      mejorMarca: cardio || !puntos.length ? null : Math.max(...puntos.map(p => p.mejorPeso)),
    };
  }

  async misEjercicios(memberId: string) {
    const series = await this.prisma.workoutSet.findMany({
      where: { memberId, deletedAt: null }, distinct: ['exerciseId'], include: { exercise: true }, orderBy: { fecha: 'desc' },
    });
    return series.map(s => ({ id: s.exerciseId, nombre: s.exercise.nombre, grupo: s.exercise.grupo, tipo: esCardio(s) ? 'cardio' : 'fuerza' }));
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
