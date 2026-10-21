import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from '../members/members.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { SettingsService } from '../settings/settings.service';
import { formatoFecha, hoyLima, rangoDelDia } from '../common/fechas';
import { hashPassword } from '../common/password';
import { congelarPlan, versionOferta } from '../plans/condiciones';
import type { DailyPassDto } from './daily-pass.controller';

const hash = (texto: string) => createHash('sha256').update(texto).digest('hex');
const normalizar = (texto: string) => texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
const esPase = (plan: any) => plan && plan.activo && plan.duracionDias === 1 && normalizar(plan.nombre) === 'pase diario' && Number.isFinite(plan.precio) && plan.precio > 0 &&
  (plan.limiteAsistencias == null || (Number.isInteger(plan.limiteAsistencias) && plan.limiteAsistencias >= 1));
const conflicto = (codigo: string, message: string, detalles: Record<string, any> = {}) => new ConflictException({ codigo, message, ...detalles });

@Injectable()
export class DailyPassService {
  constructor(private prisma: PrismaService, private members: MembersService, private receipts: ReceiptsService, private settings: SettingsService) {}

  async oferta() {
    const planes = (await this.prisma.plan.findMany({ where: { activo: true, duracionDias: 1 }, orderBy: [{ orden: 'asc' }, { id: 'asc' }] })).filter(esPase);
    const ajustes = await this.settings.obtener();
    const hoy = formatoFecha(hoyLima());
    const legal = {
      terminosVersion: ajustes.terminosVersion, terminosTexto: ajustes.terminosTexto, terminosHuella: hash(ajustes.terminosTexto),
      consentimientoVersion: ajustes.consentimientoVersion, consentimientoTexto: ajustes.consentimientoTexto, consentimientoHuella: hash(ajustes.consentimientoTexto),
    };
    if (!ajustes.terminosTexto.trim() || !ajustes.consentimientoTexto.trim()) return { disponible: false, motivo: 'Configura los textos de condiciones y consentimiento en Ajustes antes de cobrar.', plan: null, inicio: hoy, vence: hoy, legal };
    if (planes.length !== 1) return { disponible: false, motivo: planes.length ? 'Hay varios planes de Pase diario activos. Revisa el catálogo antes de cobrar.' : 'No hay un plan Pase diario activo de un día con precio válido. Configúralo en Membresías.', plan: null, inicio: hoy, vence: hoy, legal };
    const plan = planes[0];
    return { disponible: true, plan: { id: plan.id, nombre: plan.nombre, precio: plan.precio, versionOferta: versionOferta(plan), duracionDias: 1, limiteAsistencias: plan.limiteAsistencias }, inicio: hoy, vence: hoy, legal };
  }

  private huella(dto: DailyPassDto, cajeroId: string) {
    return hash(JSON.stringify({
      cajeroId, planId: dto.planId, versionOferta: dto.versionOferta, montoEsperado: dto.montoEsperado, metodo: dto.metodo,
      memberId: dto.memberId ?? null, visitante: dto.visitante ? { nombre: dto.visitante.nombre.trim().replace(/\s+/g, ' '), dni: dto.visitante.dni ?? null } : null,
      aceptaTerminos: dto.aceptaTerminos, terminosVersion: dto.terminosVersion, terminosHuella: dto.terminosHuella,
      consentimiento: dto.consentimiento, consentimientoVersion: dto.consentimientoVersion, consentimientoHuella: dto.consentimientoHuella,
    }));
  }

  private async anterior(paymentId: string, huella: string, db: Prisma.TransactionClient = this.prisma) {
    const pago = await db.payment.findUnique({ where: { id: paymentId }, include: { receipt: { include: { items: true } }, membership: { include: { plan: true } }, member: true } });
    if (!pago) return null;
    let nota: any;
    try { nota = JSON.parse(pago.nota || '{}'); } catch { nota = {}; }
    if (nota.tipo !== 'pase_diario_v1' || nota.huella !== huella) throw conflicto('OPERACION_REUTILIZADA', 'Esta operación ya se utilizó con otros datos. No vuelvas a cobrar; revisa el pago registrado.');
    if (!pago.member || !pago.membership || !pago.receipt || !nota.checkInId) throw new ServiceUnavailableException('La operación registrada necesita revisión en caja antes de volver a cobrar.');
    return this.respuesta(pago, nota.checkInId, true);
  }

  private respuesta(pago: any, checkInId: string, repetida: boolean) {
    return {
      paymentId: pago.id, membershipId: pago.membershipId, memberId: pago.memberId,
      inicio: formatoFecha(pago.membership.fechaInicio), vence: formatoFecha(pago.membership.fechaFin), monto: pago.monto,
      comprobante: pago.receipt, repetida,
      ingreso: { resultado: 'permitido', tipo: 'entrada', checkInId, socio: this.members.resumen({ ...pago.member, consents: [{ tipo: 'datos_personales', aceptado: true }] }, pago.membership, true) },
    };
  }

  async cobrar(dto: DailyPassDto, cajeroId: string, ip?: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dto.operationId || '')) throw new BadRequestException('Falta una operación válida.');
    if (!!dto.memberId === !!dto.visitante) throw new BadRequestException('Selecciona un socio o completa un visitante, nunca ambos.');
    if (!['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'].includes(dto.metodo)) throw new BadRequestException('Método de pago inválido.');
    const nombre = dto.visitante?.nombre?.trim().replace(/\s+/g, ' ');
    if (dto.visitante && (!nombre || nombre.length < 2 || nombre.length > 60 || (dto.visitante.dni !== undefined && !/^\d{8}$/.test(dto.visitante.dni)))) throw new BadRequestException('Completa el nombre del visitante (2 a 60 caracteres) y, si lo proporcionó, su DNI de 8 dígitos.');
    if (!Number.isFinite(dto.montoEsperado) || dto.montoEsperado <= 0 || Math.abs(dto.montoEsperado * 100 - Math.round(dto.montoEsperado * 100)) > .000001) throw new BadRequestException('El importe debe ser positivo con hasta dos decimales.');
    const paymentId = `pase-diario:${dto.operationId.toLowerCase()}`;
    const huella = this.huella(dto, cajeroId);
    const previa = await this.anterior(paymentId, huella);
    if (previa) return previa;
    // Nunca se entrega ni se habilita un PIN para el visitante. El hash es de un secreto no recuperable.
    const pinHash = dto.visitante ? await hashPassword(randomBytes(32).toString('hex')) : null;

    for (let intento = 0; intento < 4; intento++) {
      try {
        return await this.prisma.$transaction(async tx => {
          const repetida = await this.anterior(paymentId, huella, tx);
          if (repetida) return repetida;

          let socio = dto.memberId ? await tx.member.findUnique({ where: { id: dto.memberId } }) : dto.visitante.dni ? await tx.member.findUnique({ where: { dni: dto.visitante.dni } }) : null;
          if (dto.memberId && !socio) throw new NotFoundException('Socio no encontrado.');
          if (socio && dto.visitante && normalizar(`${socio.nombres} ${socio.apellidos}`) !== normalizar(nombre)) {
            throw conflicto('DNI_EXISTENTE', 'Ese DNI ya pertenece a una ficha con otro nombre. Revisa y selecciona el socio existente antes de cobrar.', { memberId: socio.id, socio: this.members.resumen(socio, null) });
          }
          if (!socio) socio = await tx.member.create({ data: { id: `visitante-pase:${dto.operationId.toLowerCase()}`, dni: dto.visitante.dni ?? null, nombres: nombre, apellidos: '', pinHash, pinCambiado: false, pinTemporalHasta: null, notas: 'Visitante de pase diario; acceso al portal sin habilitar.' } });
          const lock = await tx.member.updateMany({ where: { id: socio.id }, data: { portalVersion: { increment: 0 } } });
          if (!lock.count) throw new NotFoundException('Socio no encontrado.');
          // Otra réplica pudo confirmar la misma operación mientras esperábamos este lock.
          const confirmada = await this.anterior(paymentId, huella, tx);
          if (confirmada) return confirmada;
          socio = await tx.member.findUnique({ where: { id: socio.id } });
          if (!socio.activo) throw new BadRequestException('El socio está dado de baja. Revisa su ficha antes de cobrar.');

          const planLock = await tx.plan.updateMany({ where: { id: dto.planId }, data: { orden: { increment: 0 } } });
          const plan = planLock.count ? await tx.plan.findUnique({ where: { id: dto.planId } }) : null;
          if (!esPase(plan) || versionOferta(plan) !== dto.versionOferta || plan.precio !== dto.montoEsperado) throw conflicto('OFERTA_CAMBIADA', 'El Pase diario cambió o ya no está disponible. Revisa la oferta antes de cobrar.');
          const ofertas = (await tx.plan.findMany({ where: { activo: true, duracionDias: 1 } })).filter(esPase);
          if (ofertas.length !== 1 || ofertas[0].id !== plan.id) throw conflicto('OFERTA_CAMBIADA', 'El catálogo de pases diarios cambió. Revisa la oferta antes de cobrar.');
          if (plan.requiereEvidencia && !socio.esUniversitario) throw new BadRequestException('Este plan exige evidencia universitaria. Verifica la ficha antes de cobrar.');
          const ajustes = await tx.settings.findUnique({ where: { id: 'default' } });
          if (!ajustes || !ajustes.terminosTexto.trim() || !ajustes.consentimientoTexto.trim() || dto.aceptaTerminos !== true || dto.consentimiento !== true) throw new BadRequestException('Falta la aceptación expresa de las condiciones y del tratamiento de datos personales.');
          if (dto.terminosVersion !== ajustes.terminosVersion || dto.terminosHuella !== hash(ajustes.terminosTexto) || dto.consentimientoVersion !== ajustes.consentimientoVersion || dto.consentimientoHuella !== hash(ajustes.consentimientoTexto)) throw conflicto('LEGAL_CAMBIADO', 'Los textos de aceptación cambiaron. Revísalos y solicita la aceptación antes de cobrar.');

          const hoy = hoyLima();
          const ultimo = await tx.checkIn.findFirst({ where: { memberId: socio.id, resultado: 'permitido' }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }] });
          const horasMaximas = Number(process.env.HORAS_MAX_DENTRO || 6);
          const cierreOlvidado = ultimo?.tipo === 'entrada' && ultimo.timestamp.getTime() < Date.now() - horasMaximas * 60 * 60 * 1000;
          if (ultimo?.tipo === 'entrada' && !cierreOlvidado) throw conflicto('INGRESO_ABIERTO', 'Esta persona ya tiene un ingreso abierto. No vuelvas a cobrar; revisa su salida en recepción.');
          const vigentes = await tx.membership.findMany({ where: { memberId: socio.id, estado: 'activa', fechaInicio: { lte: hoy }, fechaFin: { gte: hoy } } });
          const rango = rangoDelDia(hoy);
          const asistencias = await tx.checkIn.findMany({ where: { memberId: socio.id, resultado: 'permitido', tipo: 'entrada', timestamp: { gte: rango.inicio, lt: rango.fin } }, select: { membershipId: true } });
          const yaUso = new Set(asistencias.map(x => x.membershipId));
          if (vigentes.some(m => m.limiteAsistencias == null || m.asistenciasUsadas < m.limiteAsistencias || yaUso.has(m.id))) throw conflicto('COBERTURA_VIGENTE', 'Ya tiene una membresía utilizable hoy. Registra su ingreso o reingreso sin cobrar otro pase.');

          if (cierreOlvidado) {
            // Misma política de seis horas que el cron de accesos, sin exigir esperar al próximo cron.
            await tx.locker.updateMany({ where: { memberId: socio.id }, data: { memberId: null, ocupadoDesde: null } });
            await tx.checkIn.create({ data: { memberId: socio.id, tipo: 'salida', metodo: 'auto', dispositivo: 'recepcion-pase-diario', resultado: 'permitido', motivo: 'Cierre automático: no marcó salida antes del nuevo pase diario', timestamp: new Date(Date.now() - 1) } });
          }

          const membresia = await tx.membership.create({ data: { memberId: socio.id, planId: plan.id, fechaInicio: hoy, fechaFin: hoy, precioPagado: plan.precio, ...congelarPlan(plan), asistenciasUsadas: plan.limiteAsistencias == null ? 0 : 1, observacion: 'Pase diario cobrado e ingresado desde recepción.' }, include: { plan: true } });
          const checkIn = await tx.checkIn.create({ data: { memberId: socio.id, membershipId: membresia.id, tipo: 'entrada', metodo: 'manual', dispositivo: 'recepcion-pase-diario', resultado: 'permitido' } });
          await tx.preCheckIn.updateMany({ where: { memberId: socio.id, estado: 'pendiente', expiresAt: { gt: new Date() } }, data: { estado: 'confirmado', confirmedAt: new Date(), checkInId: checkIn.id } });
          const pago = await tx.payment.create({ data: { id: paymentId, memberId: socio.id, membershipId: membresia.id, concepto: 'membresia', monto: plan.precio, metodo: dto.metodo, cajeroId, nota: JSON.stringify({ tipo: 'pase_diario_v1', huella, checkInId: checkIn.id }) } });
          await tx.consent.createMany({ data: [
            { memberId: socio.id, tipo: 'datos_personales', version: ajustes.consentimientoVersion, texto: ajustes.consentimientoTexto, origen: 'pase_diario_recepcion', aceptado: true, ip: ip || null },
            { memberId: socio.id, tipo: 'terminos', version: ajustes.terminosVersion, texto: ajustes.terminosTexto, origen: 'pase_diario_recepcion', aceptado: true, ip: ip || null },
          ] });
          const comprobante = await this.receipts.emitirInternoEnTransaccion(tx, { paymentId: pago.id, cliente: { tipoDoc: socio.dni ? 'dni' : 'sin_documento', numDoc: socio.dni || undefined, nombre: `${socio.nombres} ${socio.apellidos}`.trim() }, items: [{ descripcion: `${plan.nombre} — ${formatoFecha(hoy)}`, cantidad: 1, precioUnitario: plan.precio }], total: plan.precio, observacion: 'Recibo interno de pase diario; sin valor tributario.' }, ajustes);
          return this.respuesta({ ...pago, member: socio, membership: membresia, receipt: comprobante }, checkIn.id, false);
        }, { maxWait: 10000, timeout: 10000 });
      } catch (error) {
        // Los conflictos de estado también pueden ser el resultado de un primer intento ya confirmado.
        const confirmada = await this.anterior(paymentId, huella);
        if (confirmada) return confirmada;
        if (['P2002', 'P2034', 'P1008', 'P2028'].includes(error?.code)) {
          if (intento < 3) { await new Promise(resolve => setTimeout(resolve, 30 * (intento + 1))); continue; }
          throw new ServiceUnavailableException('Hay otro cobro en curso. Conserva esta operación y reintenta para comprobar si se registró.');
        }
        throw error;
      }
    }
  }
}
