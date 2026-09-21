import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { diaLimaDe, fechaDesdeTexto, formatoFecha, hoyLima, rangoEntre } from '../common/fechas';

export type FiltroCaja = {
  desde?: string;
  hasta?: string;
  metodo?: string;
  cajeroId?: string;
  concepto?: string;
};

@Injectable()
export class CashService {
  constructor(private prisma: PrismaService) {}

  private rango(filtro: FiltroCaja) {
    const desde = fechaDesdeTexto(filtro.desde, hoyLima());
    const hasta = fechaDesdeTexto(filtro.hasta, desde);
    return { ...rangoEntre(desde, hasta), desdeTexto: formatoFecha(desde), hastaTexto: formatoFecha(hasta) };
  }

  async pagos(filtro: FiltroCaja) {
    const { inicio, fin } = this.rango(filtro);
    const pagos = await this.prisma.payment.findMany({
      where: {
        fecha: { gte: inicio, lt: fin },
        ...(filtro.metodo ? { metodo: filtro.metodo } : {}),
        ...(filtro.cajeroId ? { cajeroId: filtro.cajeroId } : {}),
        ...(filtro.concepto ? { concepto: filtro.concepto } : {}),
      },
      orderBy: { fecha: 'desc' },
      include: {
        member: true,
        cajero: true,
        membership: { include: { plan: true } },
      },
    });

    return pagos.map((p) => ({
      id: p.id,
      fecha: p.fecha,
      dia: diaLimaDe(p.fecha),
      monto: p.monto,
      metodo: p.metodo,
      concepto: p.concepto,
      detalle: p.membership?.plan?.nombre ?? (p.concepto === 'producto' ? 'Venta de mostrador' : '—'),
      socio: p.member ? `${p.member.nombres} ${p.member.apellidos}` : 'Visitante',
      dni: p.member?.dni ?? null,
      cajero: p.cajero?.nombre ?? '—',
    }));
  }

  /**
   * Resumen del turno. El total en efectivo es el que se cuenta contra el cajon;
   * lo digital se concilia con la app del banco, no con el dinero fisico.
   */
  async resumen(filtro: FiltroCaja) {
    const { desdeTexto, hastaTexto } = this.rango(filtro);
    const pagos = await this.pagos(filtro);

    const agrupar = (clave: 'metodo' | 'concepto' | 'cajero') => {
      const mapa: Record<string, { total: number; operaciones: number }> = {};
      for (const p of pagos) {
        const k = (p as any)[clave] || '—';
        mapa[k] = { total: (mapa[k]?.total || 0) + p.monto, operaciones: (mapa[k]?.operaciones || 0) + 1 };
      }
      return Object.entries(mapa)
        .map(([nombre, v]) => ({ nombre, ...v }))
        .sort((a, b) => b.total - a.total);
    };

    const efectivo = pagos.filter((p) => p.metodo === 'efectivo').reduce((s, p) => s + p.monto, 0);

    return {
      desde: desdeTexto,
      hasta: hastaTexto,
      operaciones: pagos.length,
      total: pagos.reduce((s, p) => s + p.monto, 0),
      efectivo,
      digital: pagos.filter((p) => p.metodo !== 'efectivo').reduce((s, p) => s + p.monto, 0),
      porMetodo: agrupar('metodo'),
      porConcepto: agrupar('concepto'),
      porCajero: agrupar('cajero'),
    };
  }

  /** CSV plano: se abre en Excel sin pedir nada. */
  async exportarCsv(filtro: FiltroCaja) {
    const pagos = await this.pagos(filtro);
    const escapar = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const cabecera = ['Fecha', 'Hora', 'Socio', 'DNI', 'Concepto', 'Detalle', 'Metodo', 'Monto', 'Cajero'];

    const filas = pagos.map((p) =>
      [
        p.dia,
        new Date(p.fecha).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' }),
        p.socio,
        p.dni ?? '',
        p.concepto,
        p.detalle,
        p.metodo,
        p.monto.toFixed(2),
        p.cajero,
      ]
        .map(escapar)
        .join(','),
    );

    // El BOM es lo que hace que Excel respete las tildes.
    return '﻿' + [cabecera.map(escapar).join(','), ...filas].join('\n');
  }

  /** Arqueo: lo que dice el sistema contra lo que hay en el cajon. */
  async cerrar(dto: { desde?: string; hasta?: string; montoContado: number; nota?: string }, cajeroId?: string) {
    const { inicio, fin } = this.rango(dto);
    const resumen = await this.resumen(dto);
    const diferencia = Number((dto.montoContado - resumen.efectivo).toFixed(2));

    return this.prisma.cashClose.create({
      data: {
        cajeroId: cajeroId || null,
        desde: inicio,
        hasta: fin,
        montoSistema: resumen.efectivo,
        montoContado: dto.montoContado,
        diferencia,
        detalle: JSON.stringify(resumen.porMetodo),
        nota: dto.nota || null,
      },
    });
  }

  historialCierres(limite = 30) {
    return this.prisma.cashClose.findMany({
      orderBy: { createdAt: 'desc' },
      take: limite,
      include: { cajero: true },
    });
  }
}
