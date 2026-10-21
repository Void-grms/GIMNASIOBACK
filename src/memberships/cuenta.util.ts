import { BadRequestException } from '@nestjs/common';
import { formatoFecha, hoyLima, MS_DIA, sumarDias } from '../common/fechas';
import { esMonto } from '../common/validadores';

export function centimos(valor: number, permiteCero = true): number {
  if (!esMonto(valor) || (!permiteCero && valor <= 0)) throw new BadRequestException('El importe debe ser positivo, con hasta dos decimales y como máximo S/100000.');
  return Math.round(valor * 100);
}

/** Las fechas de negocio son dias de Lima, nunca timestamps de caja. */
export function fechaEstricta(texto: string): Date {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) throw new BadRequestException('Indica una fecha válida (AAAA-MM-DD).');
  const fecha = new Date(texto + 'T00:00:00Z');
  if (isNaN(fecha.getTime()) || formatoFecha(fecha) !== texto || texto < '2000-01-01' || texto > '2100-12-31') throw new BadRequestException('Indica una fecha válida entre los años 2000 y 2100.');
  return fecha;
}

export function pausaActual(m: any, hoy = hoyLima()) {
  return m?.congelamientos?.find((p: any) => new Date(p.desde) <= hoy && new Date(p.hasta) >= hoy) ?? null;
}

/** Otra membresia util puede dar acceso aunque un contrato este en pausa. */
export function elegirMembresia(lista: any[], hoy = hoyLima()) {
  const actuales = lista.filter(m => m.estado === 'activa' && m.fechaInicio <= hoy && m.fechaFin >= hoy);
  return actuales.find(m => !pausaActual(m, hoy) && (m.limiteAsistencias == null || m.asistenciasUsadas < m.limiteAsistencias))
    ?? actuales.find(m => !pausaActual(m, hoy)) ?? actuales[0]
    ?? lista.find(m => m.estado === 'activa') ?? lista.find(m => m.estado === 'vencida') ?? null;
}

export function cuentaDe(m: any) {
  const historica = m.totalContratadoCentimos == null;
  const totalCentimos = historica ? Math.round(m.precioPagado * 100) : m.totalContratadoCentimos;
  // Los importes historicos son el contrato ya importado; no se inventa deuda
  // porque el ERP no haya exportado todos sus movimientos de caja.
  const pagadoCentimos = historica ? totalCentimos : (m.payments ?? []).reduce((s: number, p: any) => s + (p.montoCentimos ?? Math.round(p.monto * 100)), 0);
  const saldoCentimos = Math.max(0, totalCentimos - pagadoCentimos);
  const limite = m.fechaLimiteSaldo ? formatoFecha(new Date(m.fechaLimiteSaldo)) : null;
  return {
    total: totalCentimos / 100, pagado: pagadoCentimos / 100, saldo: saldoCentimos / 100,
    fechaLimiteSaldo: limite,
    estado: saldoCentimos === 0 ? 'pagada' : limite && limite < formatoFecha(hoyLima()) ? 'vencida' : 'pendiente',
    version: m.versionCuenta ?? 0, inicio: formatoFecha(new Date(m.fechaInicio)), vence: formatoFecha(new Date(m.fechaFin)),
    plan: m.planNombre ?? m.plan?.nombre ?? 'Membresía',
    ajustes: (m.operaciones ?? []).filter((o: any) => ['inicio', 'congelamiento'].includes(o.tipo) || (o.tipo === 'venta' && o.aprobado)).map((o: any) => {
      const datos = JSON.parse(o.datos);
      return { id: o.id, tipo: o.tipo === 'venta' ? 'inicio' : o.tipo, motivo: o.motivo, aprobado: o.aprobado, usuarioId: o.usuarioId, usuarioNombre: o.usuarioNombre, rol: o.rol, fecha: o.createdAt, antes: datos.antes, despues: datos.despues };
    }),
    congelamientos: (m.congelamientos ?? []).map((p: any) => ({ id: p.id, desde: formatoFecha(new Date(p.desde)), hasta: formatoFecha(new Date(p.hasta)), dias: p.dias, motivo: p.motivo, creadoAt: p.createdAt })),
    pagos: (m.payments ?? []).map((p: any) => ({ id: p.id, monto: p.monto, metodo: p.metodo, fecha: p.fecha, cajero: p.cajero?.nombre ?? null, comprobante: p.receipt ? { id: p.receipt.id, tipo: p.receipt.tipo, serie: p.receipt.serie, numero: p.receipt.numero } : null })),
  };
}

/** Periodos utiles del contrato, descontando pausas inclusivas. */
export function intervalosActivos(m: any): Array<{ desde: number; hasta: number }> {
  let rangos = [{ desde: new Date(m.fechaInicio).getTime(), hasta: new Date(m.fechaFin).getTime() }];
  for (const pausa of m.congelamientos ?? []) {
    const desde = new Date(pausa.desde).getTime(), hasta = new Date(pausa.hasta).getTime();
    rangos = rangos.flatMap(r => hasta < r.desde || desde > r.hasta ? [r] : [
      ...(r.desde < desde ? [{ desde: r.desde, hasta: desde - MS_DIA }] : []),
      ...(r.hasta > hasta ? [{ desde: hasta + MS_DIA, hasta: r.hasta }] : []),
    ]);
  }
  return rangos;
}

export function diasCongelados(m: any): number {
  return (m.congelamientos ?? []).reduce((s: number, p: any) => s + Math.round((new Date(p.hasta).getTime() - new Date(p.desde).getTime()) / MS_DIA) + 1, 0);
}

export function finConPausas(inicio: Date, duracion: number, m: any): Date {
  return sumarDias(inicio, duracion + diasCongelados(m) - 1);
}
