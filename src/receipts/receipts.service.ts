import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { PseService } from './pse.service';
import { esDocumentoValido, redondear } from '../common/validadores';
import { diaLimaDe, fechaDesdeTexto, hoyLima, rangoEntre } from '../common/fechas';

export type DatosCliente = {
  tipoDoc: string;
  numDoc?: string;
  nombre?: string;
  direccion?: string;
};

export type LineaComprobante = {
  descripcion: string;
  cantidad?: number;
  /** Precio final que paga el cliente, con IGV incluido si el regimen lo aplica. */
  precioUnitario: number;
};

@Injectable()
export class ReceiptsService {
  private readonly log = new Logger('Comprobantes');

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private pse: PseService,
  ) {}

  /**
   * En Peru el precio de lista al consumidor ya incluye IGV: los S/ 100 del plan
   * son lo que paga el socio. Asi que el IGV se desagrega hacia atras, no se
   * suma encima.
   */
  desglosar(total: number, aplicaIgv: boolean, tasa: number) {
    if (!aplicaIgv) {
      return { gravado: 0, igv: 0, inafecto: redondear(total), total: redondear(total) };
    }
    const gravado = redondear(total / (1 + tasa));
    const igv = redondear(total - gravado);
    return { gravado, igv, inafecto: 0, total: redondear(total) };
  }

  /** Reglas que deciden si el comprobante se puede emitir tal como viene. */
  private validar(tipo: string, cliente: DatosCliente, total: number, ajustes: any) {
    if (!['boleta', 'factura', 'recibo'].includes(tipo)) {
      throw new BadRequestException('Tipo de comprobante invalido');
    }

    if (tipo === 'factura') {
      if (!this.settings.aplicaIgv(ajustes.regimen)) {
        throw new BadRequestException(
          'El regimen actual (NRUS) no permite emitir facturas. Emite una boleta o cambia de regimen en Ajustes.',
        );
      }
      if (cliente.tipoDoc !== 'ruc' || !esDocumentoValido('ruc', cliente.numDoc)) {
        throw new BadRequestException('Una factura exige el RUC del cliente y debe ser valido');
      }
      if (!cliente.nombre?.trim()) throw new BadRequestException('Falta la razon social del cliente');
      if (!cliente.direccion?.trim()) {
        throw new BadRequestException('Una factura exige la direccion fiscal del cliente');
      }
    }

    if (tipo === 'boleta') {
      // SUNAT exige identificar al comprador cuando la boleta supera el umbral.
      if (total > ajustes.umbralDocumento && cliente.tipoDoc === 'sin_documento') {
        throw new BadRequestException(
          `Por ser mayor a S/ ${ajustes.umbralDocumento} la boleta necesita el documento del cliente`,
        );
      }
      if (!esDocumentoValido(cliente.tipoDoc, cliente.numDoc)) {
        throw new BadRequestException('El documento del cliente no es valido');
      }
    }

    if (tipo !== 'recibo' && !ajustes.ruc) {
      throw new BadRequestException(
        'Falta el RUC del gimnasio en Ajustes. Sin el no se puede emitir boleta ni factura.',
      );
    }
  }

  private codigoSunat(tipo: string) {
    return tipo === 'factura' ? '01' : tipo === 'boleta' ? '03' : '';
  }

  private serieInicial(tipo: string) {
    return tipo === 'factura' ? 'F001' : tipo === 'boleta' ? 'B001' : 'R001';
  }

  /**
   * Emite el comprobante de un pago ya registrado.
   *
   * El correlativo se reserva dentro de la transaccion: dos cobros simultaneos
   * no pueden quedarse con el mismo numero, que es de las pocas cosas que SUNAT
   * no perdona.
   */
  async emitir(params: {
    paymentId?: string;
    tipo: string;
    cliente: DatosCliente;
    items: LineaComprobante[];
    total: number;
    observacion?: string;
  }) {
    const ajustes = await this.settings.obtener();
    const aplicaIgv = this.settings.aplicaIgv(ajustes.regimen) && params.tipo !== 'recibo';

    const total = redondear(params.total);
    if (total <= 0) throw new BadRequestException('El comprobante no puede ser por S/ 0');
    this.validar(params.tipo, params.cliente, total, ajustes);

    const montos = this.desglosar(total, aplicaIgv, ajustes.igvTasa);

    const comprobante = await this.prisma.$transaction(async (tx) => {
      const serie = await tx.serie.upsert({
        where: { tipo_serie: { tipo: params.tipo, serie: this.serieInicial(params.tipo) } },
        update: { correlativo: { increment: 1 } },
        create: { tipo: params.tipo, serie: this.serieInicial(params.tipo), correlativo: 1 },
      });

      return tx.receipt.create({
        data: {
          tipo: params.tipo,
          codigoSunat: this.codigoSunat(params.tipo),
          serie: serie.serie,
          numero: serie.correlativo,
          emisorRuc: ajustes.ruc,
          emisorRazon: ajustes.razonSocial,
          emisorDireccion: ajustes.direccionFiscal,
          clienteTipoDoc: params.cliente.tipoDoc,
          clienteNumDoc: params.cliente.numDoc || null,
          clienteNombre: params.cliente.nombre?.trim() || 'Cliente varios',
          clienteDireccion: params.cliente.direccion || null,
          gravado: montos.gravado,
          igv: montos.igv,
          inafecto: montos.inafecto,
          total: montos.total,
          igvTasa: aplicaIgv ? ajustes.igvTasa : 0,
          estadoSunat: params.tipo === 'recibo' ? 'no_aplica' : 'pendiente',
          observacion: params.observacion || null,
          paymentId: params.paymentId || null,
          items: {
            create: params.items.map((i) => {
              const cantidad = i.cantidad ?? 1;
              const totalLinea = redondear(i.precioUnitario * cantidad);
              const l = this.desglosar(totalLinea, aplicaIgv, ajustes.igvTasa);
              return {
                descripcion: i.descripcion,
                cantidad,
                valorUnitario: redondear((aplicaIgv ? l.gravado : totalLinea) / cantidad),
                precioUnitario: redondear(i.precioUnitario),
                igv: l.igv,
                total: totalLinea,
              };
            }),
          },
        },
        include: { items: true },
      });
    });

    // El envio al PSE va fuera de la transaccion: una demora de red no puede
    // dejar la base bloqueada ni perder el cobro.
    if (comprobante.estadoSunat === 'pendiente') {
      const r = await this.pse.enviar(comprobante, ajustes);
      return this.prisma.receipt.update({
        where: { id: comprobante.id },
        data: {
          estadoSunat: r.estado,
          sunatMensaje: r.mensaje || null,
          sunatHash: r.hash || null,
          sunatEnlace: r.enlace || null,
        },
        include: { items: true },
      });
    }

    return comprobante;
  }

  /**
   * Un comprobante emitido no se borra ni se edita: se anula dejando rastro.
   * Ante SUNAT esto corresponde a una comunicacion de baja o nota de credito,
   * que emite el PSE cuando este conectado.
   */
  async anular(id: string, motivo: string) {
    if (!motivo?.trim()) throw new BadRequestException('Anular exige un motivo');
    const comprobante = await this.prisma.receipt.findUnique({ where: { id } });
    if (!comprobante) throw new NotFoundException('Comprobante no encontrado');
    if (comprobante.anulado) throw new BadRequestException('Ese comprobante ya estaba anulado');

    return this.prisma.receipt.update({
      where: { id },
      data: { anulado: true, motivoAnulacion: motivo.trim(), anuladoAt: new Date() },
    });
  }

  async listar(filtro: { desde?: string; hasta?: string; tipo?: string }) {
    const d = fechaDesdeTexto(filtro.desde, hoyLima());
    const h = fechaDesdeTexto(filtro.hasta, d);
    const { inicio, fin } = rangoEntre(d, h);

    const comprobantes = await this.prisma.receipt.findMany({
      where: {
        emitidoAt: { gte: inicio, lt: fin },
        ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
      },
      orderBy: { emitidoAt: 'desc' },
      include: { items: true },
    });

    return comprobantes.map((c) => ({ ...c, dia: diaLimaDe(c.emitidoAt) }));
  }

  async obtener(id: string) {
    const c = await this.prisma.receipt.findUnique({ where: { id }, include: { items: true } });
    if (!c) throw new NotFoundException('Comprobante no encontrado');
    return c;
  }

  /**
   * Comprobantes que quedaron sin confirmar ante SUNAT. Si el PSE estaba caido
   * al momento del cobro, aqui es donde aparecen.
   */
  pendientes() {
    return this.prisma.receipt.findMany({
      where: { estadoSunat: { in: ['pendiente', 'rechazado'] }, anulado: false },
      orderBy: { emitidoAt: 'asc' },
      include: { items: true },
    });
  }

  /**
   * Reintenta el envio de los pendientes. Sin esto, un comprobante que fallo
   * se queda esperando para siempre y nadie se entera.
   */
  async reintentarPendientes(limite = 20) {
    const ajustes = await this.settings.obtener();
    if (ajustes.pseProveedor === 'ninguno') {
      return { intentados: 0, aceptados: 0, mensaje: 'No hay emision electronica configurada' };
    }

    const pendientes = (await this.pendientes()).slice(0, limite);
    let aceptados = 0;

    for (const comprobante of pendientes) {
      const r = await this.pse.enviar(comprobante, ajustes);
      await this.prisma.receipt.update({
        where: { id: comprobante.id },
        data: {
          estadoSunat: r.estado,
          sunatMensaje: r.mensaje || null,
          sunatHash: r.hash || null,
          sunatEnlace: r.enlace || null,
        },
      });
      if (r.estado === 'aceptado') aceptados++;
    }

    if (pendientes.length) {
      this.log.log(`Reintentados ${pendientes.length}, aceptados ${aceptados}`);
    }
    return { intentados: pendientes.length, aceptados };
  }

  @Cron('*/30 * * * *')
  async reintentoProgramado() {
    try {
      await this.reintentarPendientes();
    } catch (e: any) {
      this.log.error(`Fallo el reintento programado: ${e.message}`);
    }
  }
}
