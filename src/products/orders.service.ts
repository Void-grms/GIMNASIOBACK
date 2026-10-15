import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService, VIGENCIA_PEDIDO_MS } from './products.service';

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
  private readonly MAX_PENDIENTES = 2;

  constructor(private prisma: PrismaService, private products: ProductsService) {}

  // --------------------------------------------------------------- apartado

  private limiteVigencia() {
    return new Date(Date.now() - VIGENCIA_PEDIDO_MS);
  }

  /** Lo que ve el socio: productos activos con cuanto queda para pedir. */
  async tienda() {
    const [productos, apartado] = await Promise.all([
      this.prisma.product.findMany({ where: { activo: true }, orderBy: { nombre: 'asc' } }),
      this.products.apartados(),
    ]);
    return productos.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      precio: p.precio,
      esServicio: p.esServicio,
      esCasillero: p.esCasillero,
      fotoUrl: p.fotoUrl,
      disponible: p.esServicio ? null : Math.max(0, p.stock - (apartado.get(p.id) || 0)),
    }));
  }

  // ----------------------------------------------------------------- socio

  async crear(memberId: string, dto: { items: { productId: string; cantidad: number }[]; nota?: string }) {
    if (!dto.items?.length) throw new BadRequestException('El pedido esta vacio');

    // Una linea por producto aunque lo manden repetido.
    const cantidades = new Map<string, number>();
    for (const i of dto.items) {
      if (!i.productId || !Number.isSafeInteger(i.cantidad) || i.cantidad <= 0) throw new BadRequestException('Cantidad invalida');
      const cantidad = (cantidades.get(i.productId) || 0) + i.cantidad;
      if (!Number.isSafeInteger(cantidad) || cantidad > 10) throw new BadRequestException('Maximo 10 unidades por producto');
      cantidades.set(i.productId, cantidad);
    }

    return this.products.conInventarioBloqueado(memberId, [...cantidades.keys()], async (tx, productos, socio) => {
      if (!socio?.activo) throw new BadRequestException('Tu cuenta no esta activa');
      const pendientes = await tx.order.count({ where: {
        memberId,
        OR: [{ estado: 'pendiente', createdAt: { gte: this.limiteVigencia() } }, { estado: 'cobrando' }],
      } });
      if (pendientes >= this.MAX_PENDIENTES) throw new BadRequestException('Ya tienes pedidos esperando en recepcion. Recogelos o cancela uno antes de pedir otro.');
      const apartado = await this.products.apartados(tx, [...cantidades.keys()]);
      const porId = new Map(productos.map(p => [p.id, p]));
      let total = 0;
      const lineas: { productId: string; cantidad: number; precioUnitario: number }[] = [];

      for (const [productId, cantidad] of cantidades) {
        const producto = porId.get(productId);
        if (!producto || !producto.activo) {
          throw new BadRequestException('Uno de los productos ya no esta disponible');
        }
        if (producto.esCasillero && cantidad > 1) {
          throw new BadRequestException('Se alquila un casillero por socio');
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
      where: { id, memberId, estado: 'pendiente', createdAt: { gte: this.limiteVigencia() } },
      data: { estado: 'cancelado', canceladoPor: 'socio' },
    });
    if (r.count === 0) throw new BadRequestException('Ese pedido ya no se puede cancelar');
    return { ok: true };
  }

  // ------------------------------------------------------------- recepcion

  async pendientes() {
    const pedidos = await this.prisma.order.findMany({
      where: { estado: 'pendiente', createdAt: { gte: this.limiteVigencia() } },
      orderBy: { createdAt: 'asc' },
      include: { items: { include: { product: true } }, member: true },
    });
    return pedidos.map((p) => this.formato(p));
  }

  /**
   * Cobra el pedido y lo entrega. El cobro es una venta normal (descuenta stock,
   * registra el pago y emite comprobante). Primero se "toma" el pedido con un
   * cambio de estado condicional dentro de la transaccion de venta: si dos
   * recepcionistas pulsan a la vez, solo uno lo cobra.
   */
  async entregar(id: string, metodo: string, cajeroId: string, casilleroNumero?: number) {
    const pedido = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    const venta = await this.products.vender({
        items: pedido.items.map((i) => ({ productId: i.productId, cantidad: i.cantidad })),
        metodo,
        memberId: pedido.memberId,
        nota: `Pedido del portal #${this.codigo(pedido.id)}`,
        cajeroId,
        casilleroNumero,
      }, id);
    return { ok: true, total: venta.total, casillero: venta.casillero, comprobante: venta.comprobante, errorComprobante: venta.errorComprobante };
  }

  async cancelarEnRecepcion(id: string, cajeroId: string) {
    const r = await this.prisma.order.updateMany({
      where: { id, estado: 'pendiente', createdAt: { gte: this.limiteVigencia() } },
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
      estado: p.estado === 'pendiente' && p.createdAt < this.limiteVigencia() ? 'vencido' : p.estado,
      total: p.total,
      nota: p.nota,
      creado: p.createdAt,
      venceA: new Date(p.createdAt.getTime() + VIGENCIA_PEDIDO_MS),
      socio: p.member
        ? { id: p.member.id, nombreCompleto: `${p.member.nombres} ${p.member.apellidos}`, dni: p.member.dni }
        : undefined,
      items: p.items.map((i: any) => ({
        productId: i.productId,
        producto: i.product?.nombre,
        esCasillero: !!i.product?.esCasillero,
        cantidad: i.cantidad,
        precioUnitario: i.precioUnitario,
      })),
    };
  }
}
