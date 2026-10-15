import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Member, Prisma, Product } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { diaLimaDe, fechaDesdeTexto, hoyLima, rangoEntre } from '../common/fechas';
import { carpetaArchivos, guardarImagen } from '../common/archivos';
import { join } from 'path';

export const VIGENCIA_PEDIDO_MS = 12 * 3600 * 1000;

type SocioVenta = Pick<Member, 'id' | 'activo' | 'dni' | 'nombres' | 'apellidos'>;

type DatosComprobante = {
  tipo: string;
  clienteTipoDoc: string;
  clienteNumDoc?: string;
  clienteNombre?: string;
  clienteDireccion?: string;
};

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService, private receipts: ReceiptsService) {}

  /** El mismo orden de locks que presencia: socio, productos ordenados y luego casillero/pedido. */
  async conInventarioBloqueado<T>(
    memberId: string | undefined,
    productIds: string[],
    trabajo: (tx: Prisma.TransactionClient, productos: Product[], socio: SocioVenta | null) => Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(productIds)].sort();
    for (let intento = 0; intento < 3; intento++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          let socio: SocioVenta | null = null;
          if (memberId) {
            const bloqueo = await tx.member.updateMany({ where: { id: memberId }, data: { portalVersion: { increment: 0 } } });
            if (bloqueo.count !== 1) throw new NotFoundException('Socio no encontrado');
            socio = await tx.member.findUnique({ where: { id: memberId }, select: { id: true, activo: true, dni: true, nombres: true, apellidos: true } });
          }
          // UPDATE conserva el stock y toma un lock de fila entre replicas PostgreSQL.
          // Tambien funciona con el lock de escritura de SQLite, sin SQL especifico del motor.
          for (const id of ids) {
            const bloqueo = await tx.product.updateMany({ where: { id }, data: { stock: { increment: 0 } } });
            if (bloqueo.count !== 1) throw new NotFoundException('Producto no encontrado');
          }
          const productos = await tx.product.findMany({ where: { id: { in: ids } } });
          return trabajo(tx, productos, socio);
        }, { maxWait: 10000, timeout: 10000 });
      } catch (error) {
        if (error?.code === 'P2028') throw new ServiceUnavailableException('Hay otro cobro o pedido en curso. Intenta de nuevo en unos segundos.');
        if (!['P2034', 'P1008'].includes(error?.code)) throw error;
        if (intento === 2) throw new ServiceUnavailableException('Hay otro cobro o pedido en curso. Intenta de nuevo en unos segundos.');
        await new Promise(resolve => setTimeout(resolve, 25 * (intento + 1)));
      }
    }
  }

  /** Los pedidos vencidos no reservan; los que estan cobrando conservan sus unidades. */
  async apartados(db: Pick<Prisma.TransactionClient, 'orderItem'> = this.prisma, productIds?: string[], excluirPedidoId?: string) {
    if (productIds?.length === 0) return new Map<string, number>();
    const items = await db.orderItem.groupBy({
      by: ['productId'],
      where: {
        ...(productIds ? { productId: { in: productIds } } : {}),
        order: {
          ...(excluirPedidoId ? { id: { not: excluirPedidoId } } : {}),
          OR: [
            { estado: 'pendiente', createdAt: { gte: new Date(Date.now() - VIGENCIA_PEDIDO_MS) } },
            { estado: 'cobrando' },
          ],
        },
      },
      _sum: { cantidad: true },
    });
    return new Map(items.map(i => [i.productId, i._sum.cantidad || 0]));
  }

  listar(incluirInactivos = false) {
    return this.prisma.product.findMany({
      where: incluirInactivos ? undefined : { activo: true },
      orderBy: { nombre: 'asc' },
    });
  }

  /** Lo que hay que reponer: producto fisico por debajo de su minimo. */
  async bajoStock() {
    const productos = await this.prisma.product.findMany({
      where: { activo: true, esServicio: false },
      orderBy: { stock: 'asc' },
    });
    return productos.filter((p) => p.stock <= p.stockMinimo);
  }

  crear(dto: any) {
    return this.prisma.product.create({ data: dto });
  }

  editar(id: string, dto: any) {
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  /** Foto del producto para la tienda del portal. Es publica, como las de socios. */
  async guardarFoto(id: string, imagen: string) {
    const producto = await this.prisma.product.findUnique({ where: { id } });
    if (!producto) throw new NotFoundException('Producto no encontrado');
    const ext = guardarImagen(imagen, join(carpetaArchivos(), 'productos'), id, 1.5 * 1024 * 1024);
    return this.prisma.product.update({
      where: { id },
      data: { fotoUrl: `/uploads/productos/${id}.${ext}?v=${Date.now()}` },
    });
  }

  async quitarFoto(id: string) {
    return this.prisma.product.update({ where: { id }, data: { fotoUrl: null } });
  }

  /** Ajuste manual de inventario: reposicion, merma o correccion de conteo. */
  async ajustarStock(id: string, cantidad: number) {
    if (!Number.isInteger(cantidad) || cantidad === 0 || Math.abs(cantidad) > 10000) throw new BadRequestException('Cantidad de ajuste invalida');
    return this.conInventarioBloqueado(undefined, [id], async (tx, productos) => {
      const producto = productos[0];
      if (producto.esServicio) throw new BadRequestException('Un servicio no lleva inventario');
      const apartado = cantidad < 0 ? (await this.apartados(tx, [id])).get(id) || 0 : 0;
      if (producto.stock + cantidad < apartado) throw new BadRequestException('El ajuste dejaria menos unidades que las apartadas. Revisa los pedidos pendientes');
      const actualizado = await tx.product.updateMany({
        where: { id, stock: { gte: -cantidad } },
        data: { stock: { increment: cantidad } },
      });
      if (actualizado.count !== 1) throw new BadRequestException('El ajuste dejaria el stock negativo');
      return tx.product.findUnique({ where: { id } });
    });
  }

  /**
   * Venta de mostrador. Todo ocurre en una transaccion: o se descuenta el stock
   * y queda el pago, o no pasa nada. Una venta sin pago descuadra la caja.
   */
  async vender(dto: {
    items: { productId: string; cantidad: number }[];
    metodo: string;
    memberId?: string;
    nota?: string;
    cajeroId?: string;
    /** Obligatorio cuando se cobra el alquiler de casillero. */
    casilleroNumero?: number;
    comprobante?: {
      tipo: string;
      clienteTipoDoc: string;
      clienteNumDoc?: string;
      clienteNombre?: string;
      clienteDireccion?: string;
    };
  }, pedidoId?: string) {
    if (!dto.items?.length) throw new BadRequestException('La venta no tiene productos');
    const cantidades = new Map<string, number>();
    for (const item of dto.items) {
      if (!item.productId || !Number.isSafeInteger(item.cantidad) || item.cantidad <= 0) throw new BadRequestException('Cantidad invalida');
      const cantidad = (cantidades.get(item.productId) || 0) + item.cantidad;
      if (!Number.isSafeInteger(cantidad)) throw new BadRequestException('Cantidad invalida');
      cantidades.set(item.productId, cantidad);
    }

    // pedidoId es un argumento interno del servicio: el DTO publico no permite excluir reservas.
    const operacion = await this.conInventarioBloqueado(dto.memberId || undefined, [...cantidades.keys()], async (tx, productos, socio) => {
      if (pedidoId) {
        const pedido = await tx.order.findUnique({ where: { id: pedidoId }, include: { items: true } });
        if (!pedido || pedido.memberId !== dto.memberId || pedido.items.length !== cantidades.size ||
          pedido.items.some(i => cantidades.get(i.productId) !== i.cantidad)) throw new BadRequestException('El pedido no coincide con la venta');
        const tomado = await tx.order.updateMany({
          where: { id: pedidoId, memberId: dto.memberId, estado: 'pendiente', createdAt: { gte: new Date(Date.now() - VIGENCIA_PEDIDO_MS) } },
          data: { estado: 'cobrando' },
        });
        if (tomado.count !== 1) throw new BadRequestException('Ese pedido ya fue atendido, cancelado o vencio');
      }
      const apartado = await this.apartados(tx, productos.filter(p => !p.esServicio).map(p => p.id), pedidoId);
      const porId = new Map(productos.map(p => [p.id, p]));
      let total = 0;
      let casilleros = 0;
      const lineas: { productId: string; cantidad: number; precioUnitario: number }[] = [];

      for (const [productId, cantidad] of cantidades) {
        const producto = porId.get(productId);
        if (!producto || !producto.activo) {
          throw new NotFoundException('Producto no encontrado o inactivo');
        }
        const disponible = producto.stock - (apartado.get(productId) || 0);
        if (!producto.esServicio && disponible < cantidad) {
          throw new BadRequestException(
            `Solo quedan ${Math.max(0, disponible)} disponibles de "${producto.nombre}"`,
          );
        }
        if (!producto.esServicio) {
          const descontado = await tx.product.updateMany({
            where: { id: productId, activo: true, stock: { gte: cantidad } },
            data: { stock: { decrement: cantidad } },
          });
          if (descontado.count !== 1) throw new BadRequestException('El stock cambio. Revisa la disponibilidad antes de cobrar');
        }
        if (producto.esCasillero) casilleros += cantidad;
        total += producto.precio * cantidad;
        lineas.push({
          productId: producto.id,
          cantidad,
          precioUnitario: producto.precio,
        });
      }

      // El casillero se entrega con numero: queda a nombre del socio hasta que
      // marque su salida. Se ocupa con un cambio condicional para que dos
      // cobros simultaneos no entreguen la misma llave.
      let casillero: number | null = null;
      if (casilleros > 0) {
        if (casilleros > 1) throw new BadRequestException('Se alquila un casillero por socio');
        if (!dto.memberId) {
          throw new BadRequestException('El casillero se alquila a un socio: indica su DNI');
        }
        if (!dto.casilleroNumero) throw new BadRequestException('Elige el numero de casillero');
        const yaTiene = await tx.locker.findUnique({ where: { memberId: dto.memberId } });
        if (yaTiene) {
          throw new BadRequestException(`Este socio ya tiene el casillero ${yaTiene.numero}`);
        }
        const tomado = await tx.locker.updateMany({
          where: { numero: dto.casilleroNumero, activo: true, memberId: null },
          data: { memberId: dto.memberId, ocupadoDesde: new Date() },
        });
        if (tomado.count === 0) {
          throw new BadRequestException(`El casillero ${dto.casilleroNumero} esta ocupado o no existe`);
        }
        casillero = dto.casilleroNumero;
      }

      const venta = await tx.sale.create({
        data: {
          memberId: dto.memberId || null,
          total: Number(total.toFixed(2)),
          metodo: dto.metodo,
          cajeroId: dto.cajeroId || null,
          nota: dto.nota || null,
          items: { create: lineas },
        },
        include: { items: { include: { product: true } } },
      });

      const pago = await tx.payment.create({
        data: {
          memberId: dto.memberId || null,
          saleId: venta.id,
          concepto: 'producto',
          monto: venta.total,
          metodo: dto.metodo,
          cajeroId: dto.cajeroId || null,
        },
      });

      if (pedidoId) {
        const entregado = await tx.order.updateMany({
          where: { id: pedidoId, estado: 'cobrando', memberId: dto.memberId },
          data: { estado: 'entregado', saleId: venta.id, atendidoPor: dto.cajeroId || null, atendidoAt: new Date() },
        });
        if (entregado.count !== 1) throw new BadRequestException('El pedido cambio antes de completar el cobro');
      }
      return { venta: { ...venta, paymentId: pago.id, casillero }, socio };
    });
    const { venta, socio } = operacion;

    // El comprobante va fuera de la transaccion: el stock y el pago ya quedaron
    // firmes, y si la emision falla se puede reintentar sin deshacer la venta.
    const datos: DatosComprobante = dto.comprobante ?? {
      tipo: 'boleta',
      clienteTipoDoc: socio?.dni ? 'dni' : 'sin_documento',
      clienteNumDoc: socio?.dni || undefined,
      clienteNombre: socio ? `${socio.nombres} ${socio.apellidos}` : 'Cliente varios',
    };

    let comprobante: any = null;
    let errorComprobante: string | null = null;
    try {
      comprobante = await this.receipts.emitir({
        paymentId: venta.paymentId,
        tipo: datos.tipo,
        cliente: {
          tipoDoc: datos.clienteTipoDoc,
          numDoc: datos.clienteNumDoc,
          nombre: datos.clienteNombre,
          direccion: datos.clienteDireccion,
        },
        items: venta.items.map((i: any) => ({
          descripcion: i.product.nombre,
          cantidad: i.cantidad,
          precioUnitario: i.precioUnitario,
        })),
        total: venta.total,
      });
    } catch (e: any) {
      errorComprobante = e?.message || 'No se pudo emitir el comprobante';
    }

    return { ...venta, comprobante, errorComprobante };
  }

  async ventas(desde?: string, hasta?: string) {
    const d = fechaDesdeTexto(desde, hoyLima());
    const h = fechaDesdeTexto(hasta, d);
    const { inicio, fin } = rangoEntre(d, h);

    const ventas = await this.prisma.sale.findMany({
      where: { fecha: { gte: inicio, lt: fin } },
      orderBy: { fecha: 'desc' },
      include: { items: { include: { product: true } }, member: true, cajero: true },
    });

    return ventas.map((v) => ({
      id: v.id,
      fecha: v.fecha,
      dia: diaLimaDe(v.fecha),
      total: v.total,
      metodo: v.metodo,
      socio: v.member ? `${v.member.nombres} ${v.member.apellidos}` : 'Visitante',
      cajero: v.cajero?.nombre ?? '—',
      items: v.items.map((i) => ({
        producto: i.product.nombre,
        cantidad: i.cantidad,
        precioUnitario: i.precioUnitario,
      })),
    }));
  }
}
