import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

/**
 * Pedidos del portal: el socio aparta productos desde su celular y los paga y
 * recoge en el mostrador.
 *
 * Un pedido no toca el stock ni la caja. Lo que si hace es apartar: mientras
 * esta pendiente, sus cantidades se restan del disponible que ven los demas,
 * para que dos socios no pidan la ultima botella. El stock real baja recien
 * cuando recepcion cobra, porque ahi pasa por la venta normal.
 */
@Injectable()
export class OrdersService {
  /** Un pedido que nadie vino a recoger libera lo apartado pasadas estas horas. */
  private readonly HORAS_VIGENCIA = 12;
  private readonly MAX_PENDIENTES = 2;

  constructor(private prisma: PrismaService, private products: ProductsService) {}

  // --------------------------------------------------------------- apartado

  /** Marca como vencidos los pedidos viejos. Se llama antes de cada lectura. */
  private async vencerViejos() {
    const limite = new Date(Date.now() - this.HORAS_VIGENCIA * 3600 * 1000);
    await this.prisma.order.updateMany({
      where: { estado: 'pendiente', createdAt: { lt: limite } },
      data: { estado: 'vencido', canceladoPor: 'sistema' },
    });
  }

  /** Cantidad apartada por pedidos pendientes, por producto. */
  private async apartados(db: Pick<PrismaService, 'orderItem'> = this.prisma) {
    const items = await db.orderItem.findMany({
      where: { order: { estado: 'pendiente' } },
      select: { productId: true, cantidad: true },
    });
    const porProducto = new Map<string, number>();
    for (const i of items) {
      porProducto.set(i.productId, (porProducto.get(i.productId) || 0) + i.cantidad);
    }
    return porProducto;
  }

  /** Lo que ve el socio: productos activos con cuanto queda para pedir. */
  async tienda() {
    await this.vencerViejos();
    const [productos, apartado] = await Promise.all([
      this.prisma.product.findMany({ where: { activo: true }, orderBy: { nombre: 'asc' } }),
      this.apartados(),
    ]);
    return productos.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      precio: p.precio,
      esServicio: p.esServicio,
      disponible: p.esServicio ? null : Math.max(0, p.stock - (apartado.get(p.id) || 0)),
    }));
  }

  // ----------------------------------------------------------------- socio

  async crear(memberId: string, dto: { items: { productId: string; cantidad: number }[]; nota?: string }) {
    if (!dto.items?.length) throw new BadRequestException('El pedido esta vacio');
    await this.vencerViejos();

    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio || !socio.activo) throw new BadRequestException('Tu cuenta no esta activa');

    const pendientes = await this.prisma.order.count({ where: { memberId, estado: 'pendiente' } });
    if (pendientes >= this.MAX_PENDIENTES) {
      throw new BadRequestException(
        'Ya tienes pedidos esperando en recepcion. Recogelos o cancela uno antes de pedir otro.',
      );
    }

    // Una linea por producto aunque lo manden repetido.
    const cantidades = new Map<string, number>();
    for (const i of dto.items) {
      cantidades.set(i.productId, (cantidades.get(i.productId) || 0) + i.cantidad);
    }

    return this.prisma.$transaction(async (tx) => {
      const apartado = await this.apartados(tx);
      let total = 0;
      const lineas: { productId: string; cantidad: number; precioUnitario: number }[] = [];

      for (const [productId, cantidad] of cantidades) {
        const producto = await tx.product.findUnique({ where: { id: productId } });
        if (!producto || !producto.activo) {
          throw new BadRequestException('Uno de los productos ya no esta disponible');
        }
        if (!producto.esServicio) {
          const libre = producto.stock - (apartado.get(productId) || 0);
          if (libre < cantidad) {
            throw new BadRequestException(
              libre > 0
                ? `Solo quedan ${libre} de "${producto.nombre}"`
                : `"${producto.nombre}" esta agotado`,
            );
          }
        }
        total += producto.precio * cantidad;
        lineas.push({ productId, cantidad, precioUnitario: producto.precio });
      }

      const pedido = await tx.order.create({
        data: {
          memberId,
          total: Number(total.toFixed(2)),
          nota: dto.nota?.trim() || null,
          items: { create: lineas },
        },
        include: { items: { include: { product: true } } },
      });
      return this.formato(pedido);
    });
  }

  async misPedidos(memberId: string) {
    await this.vencerViejos();
    const pedidos = await this.prisma.order.findMany({
      where: { memberId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { items: { include: { product: true } } },
    });
    return pedidos.map((p) => this.formato(p));
  }

  async cancelarDelSocio(memberId: string, id: string) {
    const r = await this.prisma.order.updateMany({
      where: { id, memberId, estado: 'pendiente' },
      data: { estado: 'cancelado', canceladoPor: 'socio' },
    });
    if (r.count === 0) throw new BadRequestException('Ese pedido ya no se puede cancelar');
    return { ok: true };
  }

  // ------------------------------------------------------------- recepcion

  async pendientes() {
    await this.vencerViejos();
    const pedidos = await this.prisma.order.findMany({
      where: { estado: 'pendiente' },
      orderBy: { createdAt: 'asc' },
      include: { items: { include: { product: true } }, member: true },
    });
    return pedidos.map((p) => this.formato(p));
  }

  /**
   * Cobra el pedido y lo entrega. El cobro es una venta normal (descuenta stock,
   * registra el pago y emite comprobante). Primero se "toma" el pedido con un
   * cambio de estado condicional: si dos recepcionistas pulsan a la vez, solo
   * uno lo cobra.
   */
  async entregar(id: string, metodo: string, cajeroId: string) {
    const tomado = await this.prisma.order.updateMany({
      where: { id, estado: 'pendiente' },
      data: { estado: 'cobrando' },
    });
    if (tomado.count === 0) throw new BadRequestException('Ese pedido ya fue atendido o cancelado');

    const pedido = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    let venta: any;
    try {
      venta = await this.products.vender({
        items: pedido.items.map((i) => ({ productId: i.productId, cantidad: i.cantidad })),
        metodo,
        memberId: pedido.memberId,
        nota: `Pedido del portal #${this.codigo(pedido.id)}`,
        cajeroId,
      });
    } catch (e) {
      await this.prisma.order.update({ where: { id }, data: { estado: 'pendiente' } });
      throw e;
    }

    await this.prisma.order.update({
      where: { id },
      data: { estado: 'entregado', saleId: venta.id, atendidoPor: cajeroId, atendidoAt: new Date() },
    });
    return { ok: true, total: venta.total, comprobante: venta.comprobante, errorComprobante: venta.errorComprobante };
  }

  async cancelarEnRecepcion(id: string, cajeroId: string) {
    const r = await this.prisma.order.updateMany({
      where: { id, estado: 'pendiente' },
      data: { estado: 'cancelado', canceladoPor: 'recepcion', atendidoPor: cajeroId, atendidoAt: new Date() },
    });
    if (r.count === 0) throw new BadRequestException('Ese pedido ya fue atendido o cancelado');
    return { ok: true };
  }

  // -------------------------------------------------------------- formato

  /** Codigo corto para decirlo en voz alta en el mostrador. */
  private codigo(id: string) {
    return id.slice(-4).toUpperCase();
  }

  private formato(p: any) {
    return {
      id: p.id,
      codigo: this.codigo(p.id),
      estado: p.estado,
      total: p.total,
      nota: p.nota,
      creado: p.createdAt,
      venceA: new Date(p.createdAt.getTime() + this.HORAS_VIGENCIA * 3600 * 1000),
      socio: p.member
        ? { id: p.member.id, nombreCompleto: `${p.member.nombres} ${p.member.apellidos}`, dni: p.member.dni }
        : undefined,
      items: p.items.map((i: any) => ({
        productId: i.productId,
        producto: i.product?.nombre,
        cantidad: i.cantidad,
        precioUnitario: i.precioUnitario,
      })),
    };
  }
}
