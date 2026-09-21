import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { diaLimaDe, fechaDesdeTexto, hoyLima, rangoEntre } from '../common/fechas';

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

  /** Ajuste manual de inventario: reposicion, merma o correccion de conteo. */
  async ajustarStock(id: string, cantidad: number) {
    const producto = await this.prisma.product.findUnique({ where: { id } });
    if (!producto) throw new NotFoundException('Producto no encontrado');
    if (producto.esServicio) throw new BadRequestException('Un servicio no lleva inventario');
    return this.prisma.product.update({
      where: { id },
      data: { stock: { increment: cantidad } },
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
    comprobante?: {
      tipo: string;
      clienteTipoDoc: string;
      clienteNumDoc?: string;
      clienteNombre?: string;
      clienteDireccion?: string;
    };
  }) {
    if (!dto.items?.length) throw new BadRequestException('La venta no tiene productos');

    const venta = await this.prisma.$transaction(async (tx) => {
      let total = 0;
      const lineas: { productId: string; cantidad: number; precioUnitario: number }[] = [];

      for (const item of dto.items) {
        if (item.cantidad <= 0) throw new BadRequestException('Cantidad invalida');
        const producto = await tx.product.findUnique({ where: { id: item.productId } });
        if (!producto || !producto.activo) {
          throw new NotFoundException('Producto no encontrado o inactivo');
        }
        if (!producto.esServicio && producto.stock < item.cantidad) {
          throw new BadRequestException(
            `Solo quedan ${producto.stock} de "${producto.nombre}"`,
          );
        }
        total += producto.precio * item.cantidad;
        lineas.push({
          productId: producto.id,
          cantidad: item.cantidad,
          precioUnitario: producto.precio,
        });
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

      for (const linea of lineas) {
        const producto = await tx.product.findUnique({ where: { id: linea.productId } });
        if (producto && !producto.esServicio) {
          await tx.product.update({
            where: { id: linea.productId },
            data: { stock: { decrement: linea.cantidad } },
          });
        }
      }

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

      return { ...venta, paymentId: pago.id };
    });

    // El comprobante va fuera de la transaccion: el stock y el pago ya quedaron
    // firmes, y si la emision falla se puede reintentar sin deshacer la venta.
    const socio = dto.memberId
      ? await this.prisma.member.findUnique({ where: { id: dto.memberId } })
      : null;

    const datos: DatosComprobante = dto.comprobante ?? {
      tipo: 'boleta',
      clienteTipoDoc: socio ? 'dni' : 'sin_documento',
      clienteNumDoc: socio?.dni,
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
