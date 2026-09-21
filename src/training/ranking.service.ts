import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { diaLimaDe, hoyLima } from '../common/fechas';

const ZONAS = ['pecho', 'espalda', 'core', 'hombro', 'brazo', 'gluteo', 'pierna', 'cardio'];

/**
 * Ranking y retos del mes. Todo se calcula al vuelo desde los ingresos y las
 * series anotadas: no hay tablas de puntos que se puedan desincronizar.
 *
 * - Asistencia: dias distintos con ingreso en el mes (entrar dos veces el mismo
 *   dia cuenta uno, para que nadie infle el ranking entrando y saliendo).
 * - Records: ejercicios en los que este mes se levanto mas que el mejor peso
 *   de antes del mes. La primera vez que se anota un ejercicio no es record.
 */
@Injectable()
export class RankingService {
  constructor(private prisma: PrismaService) {}

  private rangoMes() {
    const hoy = hoyLima();
    // Fecha de negocio (medianoche UTC del dia 1) e instante real (00:00 de Lima).
    const inicioFecha = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
    const inicioInstante = new Date(inicioFecha.getTime() + 5 * 3600 * 1000);
    const mes = inicioFecha.toLocaleDateString('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const finMes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 0));
    return { inicioFecha, inicioInstante, mes, diasRestantes: finMes.getUTCDate() - hoy.getUTCDate() };
  }

  /** "Lucia Vasquez" -> "Lucia V." Nadie tiene por que ver el apellido de otro. */
  private nombreCorto(m: { nombres: string; apellidos: string; ocultarEnRanking: boolean }) {
    if (m.ocultarEnRanking) return 'Anonimo';
    return `${m.nombres.split(' ')[0]} ${m.apellidos.trim()[0] ?? ''}.`.trim();
  }

  private async calcular() {
    const { inicioFecha, inicioInstante } = this.rangoMes();

    const ingresos = await this.prisma.checkIn.findMany({
      where: { tipo: 'entrada', resultado: 'permitido', timestamp: { gte: inicioInstante } },
      select: { memberId: true, timestamp: true },
    });
    const diasPorSocio = new Map<string, Set<string>>();
    for (const i of ingresos) {
      if (!diasPorSocio.has(i.memberId)) diasPorSocio.set(i.memberId, new Set());
      diasPorSocio.get(i.memberId)!.add(diaLimaDe(i.timestamp));
    }

    const cardio = await this.prisma.exercise.findMany({ where: { grupo: 'cardio' }, select: { id: true } });
    const sinCardio = { notIn: cardio.map((c) => c.id) };
    const [antes, ahora] = await Promise.all([
      this.prisma.workoutSet.groupBy({
        by: ['memberId', 'exerciseId'],
        where: { fecha: { lt: inicioFecha }, exerciseId: sinCardio },
        _max: { pesoKg: true },
      }),
      this.prisma.workoutSet.groupBy({
        by: ['memberId', 'exerciseId'],
        where: { fecha: { gte: inicioFecha }, exerciseId: sinCardio },
        _max: { pesoKg: true },
      }),
    ]);
    const mejorAntes = new Map(antes.map((a) => [`${a.memberId}|${a.exerciseId}`, a._max.pesoKg ?? 0]));
    const records = new Map<string, { exerciseId: string; antes: number; ahora: number }[]>();
    for (const a of ahora) {
      const previo = mejorAntes.get(`${a.memberId}|${a.exerciseId}`);
      const actual = a._max.pesoKg ?? 0;
      if (previo && previo > 0 && actual > previo) {
        if (!records.has(a.memberId)) records.set(a.memberId, []);
        records.get(a.memberId)!.push({ exerciseId: a.exerciseId, antes: previo, ahora: actual });
      }
    }

    const ids = Array.from(new Set([...diasPorSocio.keys(), ...records.keys()]));
    const socios = await this.prisma.member.findMany({
      where: { id: { in: ids }, activo: true },
      select: { id: true, nombres: true, apellidos: true, ocultarEnRanking: true },
    });
    return { diasPorSocio, records, socios };
  }

  /** Posiciones con empates: dos socios con 10 dias comparten el puesto. */
  private tabla<T extends { valor: number }>(filas: T[]) {
    const ordenadas = filas.filter((f) => f.valor > 0).sort((a, b) => b.valor - a.valor);
    let puesto = 0;
    let anterior = -1;
    return ordenadas.map((f, i) => {
      if (f.valor !== anterior) {
        puesto = i + 1;
        anterior = f.valor;
      }
      return { ...f, puesto };
    });
  }

  private rachaMaxima(dias: Set<string> | undefined) {
    if (!dias?.size) return 0;
    const orden = Array.from(dias).sort();
    let mejor = 1;
    let actual = 1;
    for (let i = 1; i < orden.length; i++) {
      const salto = (Date.parse(orden[i]) - Date.parse(orden[i - 1])) / 86400000;
      actual = salto === 1 ? actual + 1 : 1;
      mejor = Math.max(mejor, actual);
    }
    return mejor;
  }

  /** Vista del socio: top 10, su puesto y sus retos. */
  async paraSocio(memberId: string) {
    const { mes, diasRestantes, inicioFecha } = this.rangoMes();
    const { diasPorSocio, records, socios } = await this.calcular();

    const asistencia = this.tabla(
      socios.map((s) => ({ id: s.id, nombre: this.nombreCorto(s), valor: diasPorSocio.get(s.id)?.size ?? 0 })),
    );
    const marcas = this.tabla(
      socios.map((s) => ({ id: s.id, nombre: this.nombreCorto(s), valor: records.get(s.id)?.length ?? 0 })),
    );
    const publico = (t: any[]) =>
      t.slice(0, 10).map((f) => ({ puesto: f.puesto, nombre: f.nombre, valor: f.valor, yo: f.id === memberId }));
    const mio = (t: any[]) => {
      const f = t.find((x) => x.id === memberId);
      return f ? { puesto: f.puesto, valor: f.valor, de: t.length } : null;
    };

    const misDias = diasPorSocio.get(memberId);
    const misRecords = records.get(memberId) ?? [];
    const ejercicios = await this.prisma.exercise.findMany({
      where: { id: { in: misRecords.map((r) => r.exerciseId) } },
      select: { id: true, nombre: true },
    });
    const nombreEj = new Map(ejercicios.map((e) => [e.id, e.nombre]));
    const zonasMes = await this.prisma.workoutSet.findMany({
      where: { memberId, fecha: { gte: inicioFecha } },
      distinct: ['exerciseId'],
      select: { exercise: { select: { grupo: true } } },
    });
    const zonas = new Set(zonasMes.map((z) => z.exercise.grupo).filter((g) => ZONAS.includes(g)));

    const dias = misDias?.size ?? 0;
    const racha = this.rachaMaxima(misDias);
    const retos = [
      { id: 'dias', titulo: 'Constancia', detalle: 'Ven 12 dias este mes', meta: 12, valor: dias },
      { id: 'racha', titulo: 'En racha', detalle: '5 dias seguidos', meta: 5, valor: racha },
      { id: 'records', titulo: 'Mas fuerte', detalle: 'Supera 3 marcas personales', meta: 3, valor: misRecords.length },
      { id: 'zonas', titulo: 'Cuerpo completo', detalle: 'Entrena las 8 zonas', meta: ZONAS.length, valor: zonas.size },
    ].map((r) => ({ ...r, valor: Math.min(r.valor, r.meta), logrado: r.valor >= r.meta }));

    const socio = await this.prisma.member.findUnique({ where: { id: memberId }, select: { ocultarEnRanking: true } });
    return {
      mes,
      diasRestantes,
      oculto: !!socio?.ocultarEnRanking,
      asistencia: { top: publico(asistencia), yo: mio(asistencia) },
      records: { top: publico(marcas), yo: mio(marcas) },
      misRecords: misRecords.map((r) => ({ ejercicio: nombreEj.get(r.exerciseId), antes: r.antes, ahora: r.ahora })),
      retos,
    };
  }

  /** Vista de recepcion: nombres completos, para felicitar en el mostrador. */
  async paraStaff() {
    const { mes } = this.rangoMes();
    const { diasPorSocio, records, socios } = await this.calcular();
    const completo = (s: any) => `${s.nombres} ${s.apellidos}`;
    return {
      mes,
      asistencia: this.tabla(
        socios.map((s) => ({ id: s.id, nombre: completo(s), valor: diasPorSocio.get(s.id)?.size ?? 0 })),
      ).slice(0, 10),
      records: this.tabla(
        socios.map((s) => ({ id: s.id, nombre: completo(s), valor: records.get(s.id)?.length ?? 0 })),
      ).slice(0, 10),
    };
  }
}
