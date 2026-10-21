import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { MembersService } from '../members/members.service';
import { diaLimaDe, fechaFinDe, formatoFecha, hoyLima, inicioDeNuevaMembresia, MS_DIA, rangoEntre } from '../common/fechas';
import { CondicionesPlan, congelarPlan, conPlanContratado, versionOferta } from '../plans/condiciones';
import { centimos, cuentaDe, fechaEstricta, finConPausas, intervalosActivos } from './cuenta.util';

export type DatosComprobante = { tipo: string; clienteTipoDoc: string; clienteNumDoc?: string; clienteNombre?: string; clienteDireccion?: string };
export type VentaMembresia = {
  memberId: string; planId: string; versionOferta?: string; metodo: string; monto?: number;
  observacion?: string; cajeroId?: string; aceptaTerminos?: boolean; condicionesAceptadas?: CondicionesPlan;
  comprobante?: DatosComprobante; operationId?: string; operacionInterna?: string;
  abonoInicial?: number; fechaLimiteSaldo?: string; fechaInicio?: string; inicioEsperado?: string; motivoFechas?: string; apruebaFechas?: boolean;
};
const METODOS = ['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const conflicto = (codigo: string, message: string) => new ConflictException({ codigo, message });
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => [k, canonical(v[k])])) : v;
const huellaDe = (valor: any) => createHash('sha256').update(JSON.stringify(canonical(valor))).digest('hex');
const includeCuenta = { plan: true, congelamientos: { orderBy: { desde: 'asc' as const } }, operaciones: { orderBy: { createdAt: 'desc' as const } }, payments: { orderBy: { fecha: 'desc' as const }, include: { cajero: { select: { nombre: true } }, receipt: true } } };

@Injectable()
export class MembershipsService {
  private readonly DIAS_GRACIA = Number(process.env.DIAS_GRACIA || 7);
  constructor(private prisma: PrismaService, private receipts: ReceiptsService, private members: MembersService) {}

  private idOperacion(id?: string, interna?: string) {
    if (interna) return `renovacion:${interna}`;
    if (id !== undefined && !UUID.test(id)) throw new BadRequestException('Falta una operación válida.');
    return id?.toLowerCase() ?? randomUUID();
  }

  private async anterior(id: string, huella: string, db: Prisma.TransactionClient = this.prisma) {
    const op = await db.membershipOperation.findUnique({ where: { id } });
    if (op && op.huella !== huella) throw conflicto('OPERACION_REUTILIZADA', 'Esta operación ya se registró con otros datos. Revisa el movimiento antes de volver a cobrar o ajustar.');
    return op;
  }

  /** Comprobar antes y despues del lock; recuperar tambien respuestas perdidas. */
  private async operar(id: string, huella: string, memberId: string, trabajo: (tx: Prisma.TransactionClient) => Promise<any>) {
    const anterior = await this.anterior(id, huella);
    if (anterior) return { op: anterior, repetida: true };
    for (let intento = 0; intento < 4; intento++) {
      try {
        return await this.prisma.$transaction(async tx => {
          const tomada = await tx.member.updateMany({ where: { id: memberId }, data: { portalVersion: { increment: 0 } } });
          if (!tomada.count) throw new NotFoundException('Socio no encontrado.');
          const repetida = await this.anterior(id, huella, tx);
          if (repetida) return { op: repetida, repetida: true };
          return { op: await trabajo(tx), repetida: false };
        }, { maxWait: 10000, timeout: 10000 });
      } catch (error) {
        const confirmada = await this.anterior(id, huella);
        if (confirmada) return { op: confirmada, repetida: true };
        if (['P2002', 'P2034', 'P1008', 'P2028'].includes(error?.code)) {
          if (intento < 3) { await new Promise(resolve => setTimeout(resolve, 30 * (intento + 1))); continue; }
          throw new ServiceUnavailableException('Hay otra operación en curso. Conserva esta operación y reintenta para verificar si se registró.');
        }
        throw error;
      }
    }
  }

  private async actor(tx: Prisma.TransactionClient, id?: string) {
    // HTTP siempre toma la identidad del guard; no viene en el cuerpo enviado.
    if (!id) return { usuarioId: 'sistema', usuarioNombre: 'Sistema', rol: 'sistema' };
    const user = await tx.user.findUnique({ where: { id } });
    if (!user?.activo || !['admin', 'recepcion'].includes(user.rol)) throw new ForbiddenException('Solo administración o recepción pueden registrar esta operación.');
    return { usuarioId: user.id, usuarioNombre: user.nombre, rol: user.rol };
  }

  private motivo(motivo?: string, aprobado?: boolean) {
    if (aprobado !== true || typeof motivo !== 'string' || motivo.trim().length < 5 || motivo.trim().length > 300) throw new BadRequestException('Indica el motivo (5 a 300 caracteres) y aprueba expresamente el ajuste de fechas.');
    return motivo.trim();
  }

  private async comprobarSolape(tx: Prisma.TransactionClient, candidato: any) {
    if (candidato.limiteAsistencias != null && candidato.asistenciasUsadas >= candidato.limiteAsistencias) return;
    const otros = await tx.membership.findMany({ where: { memberId: candidato.memberId, id: { not: candidato.id ?? '' }, estado: 'activa', fechaInicio: { lte: candidato.fechaFin }, fechaFin: { gte: candidato.fechaInicio } }, include: { congelamientos: true } });
    const rangos = intervalosActivos(candidato);
    if (otros.some(m => (m.limiteAsistencias == null || m.asistenciasUsadas < m.limiteAsistencias) && intervalosActivos(m).some(a => rangos.some(b => a.desde <= b.hasta && b.desde <= a.hasta)))) throw conflicto('COBERTURA_SOLAPADA', 'Las fechas se cruzan con otra membresía utilizable. Revisa ambos períodos antes de confirmar.');
  }

  private async noExcluirAsistencias(tx: Prisma.TransactionClient, m: any, inicio: Date, fin: Date) {
    const ingresos = await tx.checkIn.findMany({ where: { membershipId: m.id, resultado: 'permitido', tipo: 'entrada' }, select: { timestamp: true } });
    const desde = formatoFecha(inicio), hasta = formatoFecha(fin);
    if (ingresos.some(c => diaLimaDe(c.timestamp) < desde || diaLimaDe(c.timestamp) > hasta)) throw new BadRequestException('El nuevo período dejaría fuera asistencias ya utilizadas. Conserva el inicio y registra un congelamiento autorizado cuando corresponda.');
  }

  private solicitudRecibo(m: any, socio: any, pago: any, datos: DatosComprobante | undefined, cuenta: any, parcial: boolean) {
    const cliente: DatosComprobante = datos ?? { tipo: parcial ? 'recibo' : 'boleta', clienteTipoDoc: socio.dni ? 'dni' : 'sin_documento', clienteNumDoc: socio.dni || undefined, clienteNombre: `${socio.nombres} ${socio.apellidos}`.trim() };
    const descripcion = `${m.planNombre ?? m.plan?.nombre ?? 'Membresía'} — ${formatoFecha(m.fechaInicio)} al ${formatoFecha(m.fechaFin)}${m.limiteAsistencias == null ? '' : ` · ${m.limiteAsistencias} asistencias`}${parcial ? ' · Abono de membresía' : ''}`;
    return {
      paymentId: pago.id, tipo: cliente.tipo,
      cliente: { tipoDoc: cliente.clienteTipoDoc, numDoc: cliente.clienteNumDoc, nombre: cliente.clienteNombre || `${socio.nombres} ${socio.apellidos}`.trim(), direccion: cliente.clienteDireccion },
      items: [{ descripcion, cantidad: 1, precioUnitario: pago.monto }], total: pago.monto,
      observacion: `Plan contratado: S/${cuenta.total.toFixed(2)}. Recibido en este movimiento: S/${pago.monto.toFixed(2)}. Acumulado: S/${cuenta.pagado.toFixed(2)}. Saldo: S/${cuenta.saldo.toFixed(2)}${cuenta.fechaLimiteSaldo ? `. Completar hasta: ${cuenta.fechaLimiteSaldo}` : ''}.`,
    };
  }

  private async respuesta(op: any, repetida: boolean): Promise<any> {
    const datos = JSON.parse(op.datos);
    let comprobante: any = null, errorComprobante: string | null = null;
    if (datos.recibo) {
      try { comprobante = await this.receipts.emitir(datos.recibo); }
      catch (error) { errorComprobante = error?.message || 'El pago se registró; no se pudo emitir su comprobante.'; }
    }
    const m = await this.prisma.membership.findUnique({ where: { id: op.membershipId }, include: includeCuenta });
    if (!m) throw new ServiceUnavailableException('La operación registrada necesita revisión antes de volver a intentar.');
    const comunes = { membershipId: m.id, memberId: m.memberId, inicio: formatoFecha(m.fechaInicio), vence: formatoFecha(m.fechaFin), cuenta: cuentaDe(m), repetida };
    if (op.tipo === 'venta') return { ...conPlanContratado(m), ...comunes, arrancaDespues: m.fechaInicio > hoyLima(), paymentId: op.paymentId, monto: datos.recibo?.total ?? 0, comprobante, errorComprobante };
    if (op.tipo === 'abono') return { ...comunes, paymentId: op.paymentId, monto: datos.recibo?.total ?? 0, comprobante, errorComprobante };
    return comunes;
  }

  async vender(dto: VentaMembresia) {
    if (!dto.operacionInterna && (dto.abonoInicial !== undefined || dto.fechaInicio !== undefined) && !dto.operationId) throw new BadRequestException('El abono inicial o el inicio elegido requieren una operación válida para evitar duplicados.');
    const id = this.idOperacion(dto.operationId, dto.operacionInterna);
    const { operationId, operacionInterna, ...payload } = dto;
    const huella = huellaDe({ tipo: 'venta', ...payload, ...(operacionInterna ? { cajeroId: undefined } : {}) });
    const resultado = await this.operar(id, huella, dto.memberId, async tx => {
      if (!METODOS.includes(dto.metodo)) throw new BadRequestException('Método de pago inválido.');
      if (dto.aceptaTerminos !== true) throw new BadRequestException('Falta que el socio acepte las condiciones de la membresía antes de cobrar.');
      const actor = await this.actor(tx, dto.cajeroId);
      const socio = await tx.member.findUnique({ where: { id: dto.memberId } });
      if (!socio.activo) throw new BadRequestException('El socio está dado de baja.');
      const planLock = await tx.plan.updateMany({ where: { id: dto.planId }, data: { orden: { increment: 0 } } });
      const plan = planLock.count ? await tx.plan.findUnique({ where: { id: dto.planId } }) : null;
      if (!plan || (!plan.activo && !dto.condicionesAceptadas)) throw new NotFoundException('Plan no encontrado o inactivo.');
      if (!dto.condicionesAceptadas && dto.versionOferta !== undefined && dto.versionOferta !== versionOferta(plan)) throw conflicto('OFERTA_CAMBIADA', 'Las condiciones del plan cambiaron. Revisa la oferta antes de cobrar.');
      const condiciones = dto.condicionesAceptadas ?? congelarPlan(plan);
      if (condiciones.requiereEvidenciaContratada && !socio.esUniversitario) throw new BadRequestException(`El plan "${condiciones.planNombre}" exige evidencia universitaria vigente.`);
      const total = centimos(dto.monto ?? plan.precio);
      const abono = dto.abonoInicial === undefined ? total : centimos(dto.abonoInicial, false);
      if (abono > total) throw new BadRequestException('El recibido inicial no puede superar el precio total acordado.');
      if (condiciones.duracionDiasContratada === 1 && abono < total) throw new BadRequestException('El pase diario se paga completo. Los abonos se reservan para membresías de varios días.');
      const limite = dto.fechaLimiteSaldo ? fechaEstricta(dto.fechaLimiteSaldo) : null;
      if (abono < total && (!limite || limite < hoyLima())) throw new BadRequestException('Elige una fecha límite de saldo desde hoy.');
      const anterior = await this.periodoAnterior(dto.memberId, tx);
      const agotada = anterior?.limiteAsistencias != null && anterior.asistenciasUsadas >= anterior.limiteAsistencias;
      const automatico = condiciones.duracionDiasContratada === 1 ? hoyLima() : inicioDeNuevaMembresia(agotada ? null : anterior?.fechaFin ?? null, this.DIAS_GRACIA);
      const inicio = dto.fechaInicio ? fechaEstricta(dto.fechaInicio) : automatico;
      if (dto.inicioEsperado !== undefined && formatoFecha(inicio) !== dto.inicioEsperado) throw conflicto('VIGENCIA_CAMBIADA', 'La vigencia sugerida cambió por otra operación. Revisa el inicio y vencimiento antes de cobrar.');
      const motivo = dto.fechaInicio ? this.motivo(dto.motivoFechas, dto.apruebaFechas) : null;
      const fin = fechaFinDe(inicio, condiciones.duracionDiasContratada);
      if (condiciones.duracionDiasContratada > 1 || dto.fechaInicio) await this.comprobarSolape(tx, { memberId: dto.memberId, fechaInicio: inicio, fechaFin: fin, ...condiciones, asistenciasUsadas: 0, congelamientos: [] });
      const m = await tx.membership.create({ data: { memberId: dto.memberId, planId: plan.id, fechaInicio: inicio, fechaFin: fin, precioPagado: total / 100, totalContratadoCentimos: total, fechaLimiteSaldo: abono < total ? limite : null, versionCuenta: 1, ...condiciones, observacion: dto.observacion?.trim() || null } });
      const pago = await tx.payment.create({ data: { id: `membresia:${id}`, memberId: dto.memberId, membershipId: m.id, monto: abono / 100, montoCentimos: abono, metodo: dto.metodo, cajeroId: dto.cajeroId ?? null } });
      const ajustes = await tx.settings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
      await tx.consent.create({ data: { memberId: dto.memberId, tipo: 'terminos', version: ajustes.terminosVersion, texto: ajustes.terminosTexto, origen: 'cobro', aceptado: true } });
      const cuenta = cuentaDe({ ...m, payments: [pago] });
      const recibo = this.solicitudRecibo(m, socio, pago, dto.comprobante, cuenta, abono < total);
      return tx.membershipOperation.create({ data: { id, tipo: 'venta', huella, memberId: dto.memberId, membershipId: m.id, paymentId: pago.id, ...actor, aprobado: !!motivo, motivo, datos: JSON.stringify({ recibo, antes: { inicio: formatoFecha(automatico), vence: formatoFecha(fechaFinDe(automatico, condiciones.duracionDiasContratada)) }, despues: { inicio: formatoFecha(inicio), vence: formatoFecha(fin) } }) } });
    });
    return this.respuesta(resultado.op, resultado.repetida);
  }

  async abonar(idMembresia: string, dto: { operationId: string; monto: number; metodo: string; comprobante?: DatosComprobante }, cajeroId: string) {
    if (!UUID.test(dto.operationId ?? '')) throw new BadRequestException('Falta una operación válida.');
    const id = this.idOperacion(dto.operationId);
    const huella = huellaDe({ tipo: 'abono', membershipId: idMembresia, cajeroId, ...dto });
    const previa = await this.prisma.membership.findUnique({ where: { id: idMembresia } });
    if (!previa) throw new NotFoundException('Membresía no encontrada.');
    const resultado = await this.operar(id, huella, previa.memberId, async tx => {
      const actor = await this.actor(tx, cajeroId);
      const m = await tx.membership.findUnique({ where: { id: idMembresia }, include: { plan: true, payments: true, member: true } });
      if (m.estado === 'anulada') throw new BadRequestException('La membresía está anulada. Revisa su saldo con administración antes de registrar más cobros.');
      if (m.totalContratadoCentimos == null) throw new BadRequestException('Este contrato histórico no tiene un saldo pendiente registrado. No se crea una deuda nueva.');
      if (!METODOS.includes(dto.metodo)) throw new BadRequestException('Método de pago inválido.');
      const abono = centimos(dto.monto, false), actual = cuentaDe(m);
      if (abono > Math.round(actual.saldo * 100)) throw conflicto('SALDO_CAMBIADO', 'El abono supera el saldo actual. Revisa la cuenta antes de cobrar.');
      const pago = await tx.payment.create({ data: { id: `abono:${id}`, memberId: m.memberId, membershipId: m.id, monto: abono / 100, montoCentimos: abono, metodo: dto.metodo, cajeroId } });
      await tx.membership.update({ where: { id: m.id }, data: { versionCuenta: { increment: 1 } } });
      const cuenta = cuentaDe({ ...m, payments: [...m.payments, pago] });
      const recibo = this.solicitudRecibo(m, m.member, pago, dto.comprobante ?? { tipo: 'recibo', clienteTipoDoc: m.member.dni ? 'dni' : 'sin_documento', clienteNumDoc: m.member.dni || undefined }, cuenta, true);
      return tx.membershipOperation.create({ data: { id, tipo: 'abono', huella, memberId: m.memberId, membershipId: m.id, paymentId: pago.id, ...actor, datos: JSON.stringify({ recibo }) } });
    });
    return this.respuesta(resultado.op, resultado.repetida);
  }

  async ajustarFechas(id: string, dto: { operationId: string; fechaInicio: string; motivo: string; aprobado: boolean; version: number }, cajeroId: string) { return this.ajustar(id, dto, cajeroId, false); }
  async congelar(id: string, dto: { operationId: string; desde: string; hasta: string; motivo: string; aprobado: boolean; version: number }, cajeroId: string) { return this.ajustar(id, dto, cajeroId, true); }

  private async ajustar(idMembresia: string, dto: any, cajeroId: string, pausa: boolean) {
    if (!UUID.test(dto.operationId ?? '')) throw new BadRequestException('Falta una operación válida.');
    const id = this.idOperacion(dto.operationId), tipo = pausa ? 'congelamiento' : 'inicio';
    const huella = huellaDe({ tipo, membershipId: idMembresia, cajeroId, ...dto });
    const previa = await this.prisma.membership.findUnique({ where: { id: idMembresia } });
    if (!previa) throw new NotFoundException('Membresía no encontrada.');
    const resultado = await this.operar(id, huella, previa.memberId, async tx => {
      const actor = await this.actor(tx, cajeroId), motivo = this.motivo(dto.motivo, dto.aprobado);
      const m = await tx.membership.findUnique({ where: { id: idMembresia }, include: { plan: true, congelamientos: true } });
      if (m.estado === 'anulada') throw new BadRequestException('La membresía está anulada. No se puede modificar su vigencia.');
      if (!Number.isInteger(dto.version) || dto.version !== m.versionCuenta) throw conflicto('VERSION_CAMBIADA', 'La membresía cambió mientras revisabas sus fechas. Actualiza la cuenta antes de confirmar.');
      const duracion = m.duracionDiasContratada ?? Math.round((m.fechaFin.getTime() - m.fechaInicio.getTime()) / MS_DIA) + 1;
      let inicio = m.fechaInicio, fin: Date;
      if (pausa) {
        const desde = fechaEstricta(dto.desde), hasta = fechaEstricta(dto.hasta);
        if (hasta < desde || desde < m.fechaInicio || hasta > m.fechaFin) throw new BadRequestException('El congelamiento debe estar dentro del período actual, con fecha final igual o posterior al inicio.');
        if (m.congelamientos.some(p => p.desde <= hasta && p.hasta >= desde)) throw new BadRequestException('Ese período ya contiene días congelados. No se puede ampliar dos veces por los mismos días.');
        const rango = rangoEntre(desde, hasta);
        if (await tx.checkIn.count({ where: { membershipId: m.id, resultado: 'permitido', tipo: 'entrada', timestamp: { gte: rango.inicio, lt: rango.fin } } })) throw new BadRequestException('Hay asistencias utilizadas en esos días. No pueden convertirse en días congelados.');
        const dias = Math.round((hasta.getTime() - desde.getTime()) / MS_DIA) + 1;
        const nueva = { id: `pausa:${id}`, membershipId: m.id, operationId: id, desde, hasta, dias, motivo };
        fin = new Date(m.fechaFin.getTime() + dias * MS_DIA);
        await this.comprobarSolape(tx, { ...m, fechaFin: fin, congelamientos: [...m.congelamientos, nueva] });
        await tx.membershipFreeze.create({ data: nueva });
      } else {
        inicio = fechaEstricta(dto.fechaInicio);
        if (m.asistenciasUsadas > 0 && inicio > hoyLima()) throw new BadRequestException('La membresía ya tiene asistencias utilizadas. No puede reiniciarse en una fecha futura; registra un congelamiento autorizado.');
        fin = finConPausas(inicio, duracion, m);
        if (m.congelamientos.some(p => p.desde < inicio || p.hasta > fin)) throw new BadRequestException('Las nuevas fechas dejarían fuera congelamientos autorizados. Conserva su período histórico.');
        await this.noExcluirAsistencias(tx, m, inicio, fin);
        await this.comprobarSolape(tx, { ...m, fechaInicio: inicio, fechaFin: fin });
      }
      await tx.membership.update({ where: { id: m.id }, data: { fechaInicio: inicio, fechaFin: fin, duracionDiasContratada: duracion, versionCuenta: { increment: 1 }, estado: fin >= hoyLima() ? 'activa' : 'vencida' } });
      return tx.membershipOperation.create({ data: { id, tipo, huella, memberId: m.memberId, membershipId: m.id, ...actor, motivo, aprobado: true, datos: JSON.stringify({ antes: { inicio: formatoFecha(m.fechaInicio), vence: formatoFecha(m.fechaFin) }, despues: { inicio: formatoFecha(inicio), vence: formatoFecha(fin) } }) } });
    });
    return this.respuesta(resultado.op, resultado.repetida);
  }

  private async periodoAnterior(memberId: string, db: Prisma.TransactionClient = this.prisma) {
    const periodos = await db.membership.findMany({ where: { memberId, estado: 'activa' }, orderBy: [{ fechaFin: 'desc' }, { createdAt: 'desc' }] });
    const hoy = hoyLima();
    return periodos.find(m => m.fechaFin >= hoy && (m.limiteAsistencias == null || m.asistenciasUsadas < m.limiteAsistencias)) ?? periodos[0] ?? null;
  }

  async anular(id: string, motivo?: string) {
    const previa = await this.prisma.membership.findUnique({ where: { id } });
    if (!previa) throw new NotFoundException('Membresía no encontrada.');
    return this.prisma.$transaction(async tx => {
      await tx.member.update({ where: { id: previa.memberId }, data: { portalVersion: { increment: 0 } } });
      return tx.membership.update({ where: { id }, data: { estado: 'anulada', observacion: motivo || previa.observacion, versionCuenta: { increment: 1 } } });
    });
  }

  async listarDeSocio(memberId: string) {
    const lista = await this.prisma.membership.findMany({ where: { memberId }, orderBy: { fechaInicio: 'desc' }, include: includeCuenta });
    return lista.map(m => ({ ...conPlanContratado(m), cuenta: cuentaDe(m) }));
  }

  async cuenta(id: string) {
    const m = await this.prisma.membership.findUnique({ where: { id }, include: includeCuenta });
    if (!m) throw new NotFoundException('Membresía no encontrada.');
    return cuentaDe(m);
  }

  async pendientes() {
    const lista = await this.prisma.membership.findMany({ where: { totalContratadoCentimos: { not: null } }, orderBy: [{ fechaLimiteSaldo: 'asc' }, { createdAt: 'asc' }], include: { ...includeCuenta, member: { select: { id: true, nombres: true, apellidos: true, dni: true, codigoERP: true } } } });
    return lista.map(m => ({ membershipId: m.id, memberId: m.memberId, estadoMembresia: m.estado, socio: { id: m.memberId, nombreCompleto: `${m.member.nombres} ${m.member.apellidos}`.trim(), dni: m.member.dni, codigoERP: m.member.codigoERP }, plan: m.planNombre ?? m.plan.nombre, inicio: formatoFecha(m.fechaInicio), vence: formatoFecha(m.fechaFin), cuenta: cuentaDe(m) })).filter(m => m.cuenta.saldo > 0);
  }

  async previsualizar(memberId: string, planId: string, fechaInicio?: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan?.activo) throw new NotFoundException('Plan no encontrado o inactivo.');
    const anterior = await this.periodoAnterior(memberId);
    const inicio = fechaInicio ? fechaEstricta(fechaInicio) : plan.duracionDias === 1 ? hoyLima() : inicioDeNuevaMembresia(anterior?.limiteAsistencias != null && anterior.asistenciasUsadas >= anterior.limiteAsistencias ? null : anterior?.fechaFin ?? null, this.DIAS_GRACIA);
    return { plan: plan.nombre, precio: plan.precio, duracionDias: plan.duracionDias, limiteAsistencias: plan.limiteAsistencias, descripcion: plan.descripcion, esPromocion: plan.esPromocion, versionOferta: versionOferta(plan), inicio: formatoFecha(inicio), vence: formatoFecha(fechaFinDe(inicio, plan.duracionDias)) };
  }
}
