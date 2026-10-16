import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { MembersService } from '../members/members.service';
import { fechaFinDe, formatoFecha, hoyLima, inicioDeNuevaMembresia } from '../common/fechas';
import { comprobarOferta, CondicionesPlan, congelarPlan, conPlanContratado, versionOferta } from '../plans/condiciones';

type DatosComprobante = {
  tipo: string;
  clienteTipoDoc: string;
  clienteNumDoc?: string;
  clienteNombre?: string;
  clienteDireccion?: string;
};

const METODOS = ['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'];

@Injectable()
export class MembershipsService {
  /**
   * Dias de gracia: hasta aqui, una renovacion atrasada sigue arrancando el dia
   * siguiente al vencimiento (el socio no pierde dias). Pasado el plazo, arranca hoy.
   */
  private readonly DIAS_GRACIA = Number(process.env.DIAS_GRACIA || 7);

  constructor(
    private prisma: PrismaService,
    private receipts: ReceiptsService,
    private members: MembersService,
  ) {}

  async vender(dto: {
    memberId: string;
    planId: string;
    versionOferta?: string;
    metodo: string;
    monto?: number;
    observacion?: string;
    cajeroId?: string;
    aceptaTerminos?: boolean;
    /** Solo uso interno: oferta ya aceptada en una solicitud de renovacion. */
    condicionesAceptadas?: CondicionesPlan;
    comprobante?: {
      tipo: string;
      clienteTipoDoc: string;
      clienteNumDoc?: string;
      clienteNombre?: string;
      clienteDireccion?: string;
    };
  }) {
    if (!METODOS.includes(dto.metodo)) {
      throw new BadRequestException(`Metodo de pago invalido. Use: ${METODOS.join(', ')}`);
    }

    // El consumidor tiene que ver y aceptar las condiciones antes de pagar.
    if (!dto.aceptaTerminos) {
      throw new BadRequestException(
        'Falta que el socio acepte las condiciones de la membresia antes de cobrar',
      );
    }
    const { socio, condiciones, membresia, esPaseDiario, fechaInicio, fechaFin, monto } = await this.crearVenta(dto);

    await this.members.registrarConsentimiento(dto.memberId, 'terminos', 'cobro');

    // El comprobante se emite despues del cobro: si algo falla al emitirlo, el
    // pago ya esta registrado y se puede reemitir, que es el orden correcto.
    const datos: DatosComprobante = dto.comprobante ?? {
      tipo: 'boleta',
      clienteTipoDoc: socio.dni ? 'dni' : 'sin_documento',
      clienteNumDoc: socio.dni || undefined,
      clienteNombre: `${socio.nombres} ${socio.apellidos}`,
    };

    let comprobante: any = null;
    let errorComprobante: string | null = null;
    try {
      comprobante = await this.receipts.emitir({
        paymentId: membresia.payments[0]?.id,
        tipo: datos.tipo,
        cliente: {
          tipoDoc: datos.clienteTipoDoc,
          numDoc: datos.clienteNumDoc,
          nombre: datos.clienteNombre || `${socio.nombres} ${socio.apellidos}`,
          direccion: datos.clienteDireccion,
        },
        items: [
          {
            descripcion: `${condiciones.planNombre} — ${formatoFecha(fechaInicio)} al ${formatoFecha(fechaFin)}${condiciones.limiteAsistencias === null ? '' : ` · ${condiciones.limiteAsistencias} asistencias`}`,
            cantidad: 1,
            precioUnitario: monto,
          },
        ],
        total: monto,
      });
    } catch (e: any) {
      errorComprobante = e?.message || 'No se pudo emitir el comprobante';
    }

    return {
      ...conPlanContratado(membresia),
      inicio: formatoFecha(membresia.fechaInicio),
      vence: formatoFecha(membresia.fechaFin),
      arrancaDespues: !esPaseDiario && fechaInicio.getTime() > hoyLima().getTime(),
      paymentId: membresia.payments[0]?.id ?? null,
      comprobante,
      errorComprobante,
    };
  }

  private async crearVenta(dto: {
    memberId: string; planId: string; metodo: string; monto?: number; observacion?: string;
    cajeroId?: string; condicionesAceptadas?: CondicionesPlan; versionOferta?: string;
  }) {
    for (let intento = 0; intento < 3; intento++) {
      try {
        return await this.prisma.$transaction(async tx => {
          // Mismo orden de locks que asistencia: primero socio, despues catalogo.
          const tomada = await tx.member.updateMany({ where: { id: dto.memberId }, data: { portalVersion: { increment: 0 } } });
          if (!tomada.count) throw new NotFoundException('Socio no encontrado');
          const socio = await tx.member.findUnique({ where: { id: dto.memberId } });
          const planTomado = await tx.plan.updateMany({ where: { id: dto.planId }, data: { orden: { increment: 0 } } });
          if (!planTomado.count) throw new NotFoundException('Plan no encontrado');
          const plan = await tx.plan.findUnique({ where: { id: dto.planId } });
          if (!dto.condicionesAceptadas) comprobarOferta(plan, dto.versionOferta);
          if (!plan.activo && !dto.condicionesAceptadas) throw new NotFoundException('Plan no encontrado o inactivo');
          if (!socio.activo) throw new BadRequestException('El socio esta dado de baja');
          const condiciones = dto.condicionesAceptadas ?? congelarPlan(plan);
          if (condiciones.requiereEvidenciaContratada && !socio.esUniversitario) {
            throw new BadRequestException(`El plan "${condiciones.planNombre}" exige evidencia. Verifica el carne universitario vigente.`);
          }
          const anterior = await this.periodoAnterior(dto.memberId, tx);
          const agotada = anterior?.limiteAsistencias != null && anterior.asistenciasUsadas >= anterior.limiteAsistencias;
          const esPaseDiario = condiciones.duracionDiasContratada === 1;
          const fechaInicio = esPaseDiario ? hoyLima() : inicioDeNuevaMembresia(agotada ? null : anterior?.fechaFin ?? null, this.DIAS_GRACIA);
          const fechaFin = fechaFinDe(fechaInicio, condiciones.duracionDiasContratada);
          const monto = dto.monto ?? plan.precio;
          if (!Number.isFinite(monto) || monto < 0 || Math.abs(monto * 100 - Math.round(monto * 100)) > 0.000001) {
            throw new BadRequestException('El monto debe ser positivo o cero, con hasta dos decimales');
          }
          const membresia = await tx.membership.create({
            data: { memberId: dto.memberId, planId: plan.id, fechaInicio, fechaFin, precioPagado: monto,
              ...condiciones, observacion: dto.observacion || null,
              payments: { create: { memberId: dto.memberId, monto, metodo: dto.metodo, cajeroId: dto.cajeroId || null } } },
            include: { plan: true, payments: true },
          });
          return { socio, condiciones, membresia, esPaseDiario, fechaInicio, fechaFin, monto };
        }, { maxWait: 10000, timeout: 10000 });
      } catch (error) {
        if (['P2034', 'P1008'].includes(error?.code) && intento < 2) {
          await new Promise(resolve => setTimeout(resolve, 25 * (intento + 1)));
          continue;
        }
        if (['P2028', 'P2034', 'P1008'].includes(error?.code)) throw new ServiceUnavailableException('Hay otro cobro en curso. Intenta de nuevo en unos segundos.');
        throw error;
      }
    }
  }

  /** Un periodo agotado no debe tapar otro util, aunque venza mas tarde. */
  private async periodoAnterior(memberId: string, db: Prisma.TransactionClient = this.prisma) {
    const periodos = await db.membership.findMany({
      where: { memberId, estado: 'activa' }, orderBy: [{ fechaFin: 'desc' }, { createdAt: 'desc' }],
    });
    const hoy = hoyLima();
    return periodos.find(m => m.fechaFin >= hoy &&
      (m.limiteAsistencias == null || m.asistenciasUsadas < m.limiteAsistencias)) ?? periodos[0] ?? null;
  }

  async anular(id: string, motivo?: string) {
    const membresia = await this.prisma.membership.findUnique({ where: { id } });
    if (!membresia) throw new NotFoundException('Membresia no encontrada');
    return this.prisma.membership.update({
      where: { id },
      data: { estado: 'anulada', observacion: motivo || membresia.observacion },
    });
  }

  async listarDeSocio(memberId: string) {
    const lista = await this.prisma.membership.findMany({
      where: { memberId },
      orderBy: { fechaInicio: 'desc' },
      include: { plan: true, payments: true },
    });
    return lista.map(conPlanContratado);
  }

  /** Simulacion: que fechas tendria la venta sin registrarla. Sirve para la UI. */
  async previsualizar(memberId: string, planId: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.activo) throw new NotFoundException('Plan no encontrado o inactivo');
    const anterior = await this.periodoAnterior(memberId);
    const inicio =
      plan.duracionDias === 1
        ? hoyLima()
        : inicioDeNuevaMembresia(anterior?.limiteAsistencias != null && anterior.asistenciasUsadas >= anterior.limiteAsistencias ? null : anterior?.fechaFin ?? null, this.DIAS_GRACIA);
    return {
      plan: plan.nombre,
      precio: plan.precio,
      duracionDias: plan.duracionDias,
      limiteAsistencias: plan.limiteAsistencias,
      descripcion: plan.descripcion,
      esPromocion: plan.esPromocion,
      versionOferta: versionOferta(plan),
      inicio: formatoFecha(inicio),
      vence: formatoFecha(fechaFinDe(inicio, plan.duracionDias)),
    };
  }
}
