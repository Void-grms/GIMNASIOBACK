import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { MembersService } from '../members/members.service';
import { fechaFinDe, formatoFecha, hoyLima, inicioDeNuevaMembresia } from '../common/fechas';

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
    metodo: string;
    monto?: number;
    observacion?: string;
    cajeroId?: string;
    aceptaTerminos?: boolean;
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

    const [socio, plan] = await Promise.all([
      this.prisma.member.findUnique({ where: { id: dto.memberId } }),
      this.prisma.plan.findUnique({ where: { id: dto.planId } }),
    ]);
    if (!socio) throw new NotFoundException('Socio no encontrado');
    if (!plan || !plan.activo) throw new NotFoundException('Plan no encontrado o inactivo');
    if (!socio.activo) throw new BadRequestException('El socio esta dado de baja');
    // El consumidor tiene que ver y aceptar las condiciones antes de pagar.
    if (!dto.aceptaTerminos) {
      throw new BadRequestException(
        'Falta que el socio acepte las condiciones de la membresia antes de cobrar',
      );
    }
    if (plan.requiereEvidencia && !socio.esUniversitario) {
      throw new BadRequestException(
        `El plan "${plan.nombre}" exige evidencia. Marca al socio como universitario tras verificar su carne vigente.`,
      );
    }

    const anterior = await this.prisma.membership.findFirst({
      where: { memberId: dto.memberId, estado: 'activa' },
      orderBy: { fechaFin: 'desc' },
    });

    // El pase diario siempre es para hoy; no se encola detras de otra membresia.
    const esPaseDiario = plan.duracionDias === 1;
    const fechaInicio = esPaseDiario
      ? hoyLima()
      : inicioDeNuevaMembresia(anterior?.fechaFin ?? null, this.DIAS_GRACIA);
    const fechaFin = fechaFinDe(fechaInicio, plan.duracionDias);
    const monto = dto.monto ?? plan.precio;

    const membresia = await this.prisma.membership.create({
      data: {
        memberId: dto.memberId,
        planId: plan.id,
        fechaInicio,
        fechaFin,
        precioPagado: monto,
        observacion: dto.observacion || null,
        payments: {
          create: {
            memberId: dto.memberId,
            monto,
            metodo: dto.metodo,
            cajeroId: dto.cajeroId || null,
          },
        },
      },
      include: { plan: true, payments: true },
    });

    await this.members.registrarConsentimiento(dto.memberId, 'terminos', 'cobro');

    // El comprobante se emite despues del cobro: si algo falla al emitirlo, el
    // pago ya esta registrado y se puede reemitir, que es el orden correcto.
    const datos: DatosComprobante = dto.comprobante ?? {
      tipo: 'boleta',
      clienteTipoDoc: 'dni',
      clienteNumDoc: socio.dni,
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
            descripcion: `${plan.nombre} — ${formatoFecha(fechaInicio)} al ${formatoFecha(fechaFin)}`,
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
      ...membresia,
      inicio: formatoFecha(membresia.fechaInicio),
      vence: formatoFecha(membresia.fechaFin),
      arrancaDespues: !esPaseDiario && fechaInicio.getTime() > hoyLima().getTime(),
      comprobante,
      errorComprobante,
    };
  }

  async anular(id: string, motivo?: string) {
    const membresia = await this.prisma.membership.findUnique({ where: { id } });
    if (!membresia) throw new NotFoundException('Membresia no encontrada');
    return this.prisma.membership.update({
      where: { id },
      data: { estado: 'anulada', observacion: motivo || membresia.observacion },
    });
  }

  listarDeSocio(memberId: string) {
    return this.prisma.membership.findMany({
      where: { memberId },
      orderBy: { fechaInicio: 'desc' },
      include: { plan: true, payments: true },
    });
  }

  /** Simulacion: que fechas tendria la venta sin registrarla. Sirve para la UI. */
  async previsualizar(memberId: string, planId: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan no encontrado');
    const anterior = await this.prisma.membership.findFirst({
      where: { memberId, estado: 'activa' },
      orderBy: { fechaFin: 'desc' },
    });
    const inicio =
      plan.duracionDias === 1
        ? hoyLima()
        : inicioDeNuevaMembresia(anterior?.fechaFin ?? null, this.DIAS_GRACIA);
    return {
      plan: plan.nombre,
      precio: plan.precio,
      duracionDias: plan.duracionDias,
      inicio: formatoFecha(inicio),
      vence: formatoFecha(fechaFinDe(inicio, plan.duracionDias)),
    };
  }
}
