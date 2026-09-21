import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MS_DIA, diaLimaDe, formatoFecha, hoyLima, rangoDelDia, sumarDias } from '../common/fechas';
import { CheckinsService } from '../checkins/checkins.service';

@Injectable()
export class DashboardService {
  /** Dias sin venir tras los cuales un socio activo entra en la lista de riesgo. */
  private readonly DIAS_RIESGO = 10;

  constructor(private prisma: PrismaService, private checkins: CheckinsService) {}

  async resumen() {
    const hoy = hoyLima();
    const en7 = sumarDias(hoy, 7);
    const dia = rangoDelDia(hoy);
    const inicioMes = rangoDelDia(
      new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1)),
    ).inicio;

    const [vigentes, pagosHoy, pagosMes, ingresosHoy, porVencer] = await Promise.all([
      this.prisma.membership.findMany({
        where: { estado: 'activa', fechaFin: { gte: hoy }, fechaInicio: { lte: hoy } },
        include: { plan: true },
      }),
      this.prisma.payment.findMany({ where: { fecha: { gte: dia.inicio, lt: dia.fin } } }),
      this.prisma.payment.findMany({ where: { fecha: { gte: inicioMes } }, include: { membership: { include: { plan: true } } } }),
      this.prisma.checkIn.count({
        where: {
          resultado: 'permitido',
          tipo: 'entrada',
          timestamp: { gte: dia.inicio, lt: dia.fin },
        },
      }),
      this.prisma.membership.findMany({
        where: { estado: 'activa', fechaFin: { gte: hoy, lte: en7 } },
        include: { member: true, plan: true },
        orderBy: { fechaFin: 'asc' },
      }),
    ]);

    const sociosActivos = new Set(vigentes.map((m) => m.memberId)).size;

    // Ingreso mensual equivalente: cada membresia vigente aporta su precio
    // prorrateado a 30 dias. Comparable entre planes de distinta duracion.
    const mrr = vigentes.reduce(
      (suma, m) => suma + (m.precioPagado / Math.max(m.plan.duracionDias, 1)) * 30,
      0,
    );

    const mix: Record<string, number> = {};
    for (const pago of pagosMes) {
      const etiqueta = pago.membership?.plan?.nombre || 'Otros';
      mix[etiqueta] = (mix[etiqueta] || 0) + pago.monto;
    }

    return {
      fecha: formatoFecha(hoy),
      sociosActivos,
      ingresosHoy: pagosHoy.reduce((s, p) => s + p.monto, 0),
      pagosHoy: pagosHoy.length,
      ingresosMes: pagosMes.reduce((s, p) => s + p.monto, 0),
      mrrEstimado: Math.round(mrr * 100) / 100,
      checkInsHoy: ingresosHoy,
      dentroAhora: (await this.checkins.sociosDentro()).length,
      porVencer: porVencer.map((m) => ({
        membresiaId: m.id,
        memberId: m.memberId,
        nombre: `${m.member.nombres} ${m.member.apellidos}`,
        telefono: m.member.telefono,
        plan: m.plan.nombre,
        vence: formatoFecha(m.fechaFin),
      })),
      mixIngresos: Object.entries(mix)
        .map(([plan, monto]) => ({ plan, monto }))
        .sort((a, b) => b.monto - a.monto),
    };
  }

  /**
   * Socios que pagaron pero dejaron de venir. Es la lista de llamadas de la
   * semana y la metrica que mas plata devuelve.
   */
  async enRiesgo() {
    const hoy = hoyLima();
    const corte = new Date(Date.now() - this.DIAS_RIESGO * MS_DIA);

    const vigentes = await this.prisma.membership.findMany({
      where: { estado: 'activa', fechaFin: { gte: hoy }, fechaInicio: { lte: hoy } },
      include: { member: true, plan: true },
    });

    const enRiesgo = [];
    for (const membresia of vigentes) {
      const ultima = await this.prisma.checkIn.findFirst({
        where: { memberId: membresia.memberId, resultado: 'permitido', tipo: 'entrada' },
        orderBy: { timestamp: 'desc' },
      });
      if (!ultima || ultima.timestamp < corte) {
        enRiesgo.push({
          memberId: membresia.memberId,
          nombre: `${membresia.member.nombres} ${membresia.member.apellidos}`,
          telefono: membresia.member.telefono,
          plan: membresia.plan.nombre,
          vence: formatoFecha(membresia.fechaFin),
          ultimaVisita: ultima ? diaLimaDe(ultima.timestamp) : null,
          diasSinVenir: ultima
            ? Math.floor((Date.now() - ultima.timestamp.getTime()) / MS_DIA)
            : null,
        });
      }
    }
    return enRiesgo.sort((a, b) => (b.diasSinVenir ?? 999) - (a.diasSinVenir ?? 999));
  }

  /** Mapa de calor dia x hora con los ingresos de los ultimos 30 dias. */
  async ocupacion() {
    const desde = new Date(Date.now() - 30 * MS_DIA);
    const registros = await this.prisma.checkIn.findMany({
      where: { resultado: 'permitido', tipo: 'entrada', timestamp: { gte: desde } },
      select: { timestamp: true },
    });

    const celdas: Record<string, number> = {};
    for (const r of registros) {
      // Hora de Lima = UTC-5
      const lima = new Date(r.timestamp.getTime() - 5 * 3600 * 1000);
      const clave = `${lima.getUTCDay()}-${lima.getUTCHours()}`;
      celdas[clave] = (celdas[clave] || 0) + 1;
    }

    return Object.entries(celdas).map(([clave, total]) => {
      const [dia, hora] = clave.split('-').map(Number);
      return { dia, hora, total };
    });
  }

  /**
   * Cohortes de retencion: de los que se inscribieron en un mes, cuantos
   * seguian con membresia vigente uno, dos y tres meses despues.
   *
   * Es el unico numero que distingue un gimnasio que crece de uno que solo
   * reemplaza a los que se van.
   */
  async cohortes(meses = 6) {
    const membresias = await this.prisma.membership.findMany({
      where: { estado: 'activa' },
      select: { memberId: true, fechaInicio: true, fechaFin: true },
      orderBy: { fechaInicio: 'asc' },
    });
    if (membresias.length === 0) return { cohortes: [], periodos: [] };

    // Cada socio pertenece a la cohorte del mes de su primera membresia.
    const primera = new Map<string, Date>();
    const porSocio = new Map<string, { inicio: Date; fin: Date }[]>();
    for (const m of membresias) {
      if (!primera.has(m.memberId)) primera.set(m.memberId, m.fechaInicio);
      if (!porSocio.has(m.memberId)) porSocio.set(m.memberId, []);
      porSocio.get(m.memberId)!.push({ inicio: m.fechaInicio, fin: m.fechaFin });
    }

    const clave = (d: Date) => formatoFecha(d).slice(0, 7);
    const hoy = hoyLima();
    const mesActual = hoy.getUTCFullYear() * 12 + hoy.getUTCMonth();

    const cohortes = new Map<string, string[]>();
    for (const [memberId, inicio] of primera) {
      const k = clave(inicio);
      if (!cohortes.has(k)) cohortes.set(k, []);
      cohortes.get(k)!.push(memberId);
    }

    /** Sigue vigente en el mes N despues de su alta? */
    const seguiaEn = (memberId: string, base: Date, desplazamiento: number) => {
      const objetivo = new Date(
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + desplazamiento, 15),
      );
      return (porSocio.get(memberId) || []).some(
        (m) => m.inicio.getTime() <= objetivo.getTime() && m.fin.getTime() >= objetivo.getTime(),
      );
    };

    const claves = Array.from(cohortes.keys()).sort().slice(-meses);
    const filas = claves.map((k) => {
      const miembros = cohortes.get(k)!;
      const base = new Date(`${k}-01T00:00:00Z`);
      const mesCohorte = base.getUTCFullYear() * 12 + base.getUTCMonth();

      const retencion = [0, 1, 2, 3].map((desplazamiento) => {
        // Un mes que todavia no llego no se muestra como cero.
        if (mesCohorte + desplazamiento > mesActual) return null;
        const siguen = miembros.filter((id) => seguiaEn(id, base, desplazamiento)).length;
        return {
          mes: desplazamiento,
          socios: siguen,
          porcentaje: Math.round((siguen / miembros.length) * 100),
        };
      });

      return { cohorte: k, nuevos: miembros.length, retencion };
    });

    return { cohortes: filas, periodos: [0, 1, 2, 3] };
  }
}
