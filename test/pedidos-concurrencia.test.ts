/** Integracion: el llamador proporciona un cliente de base AISLADA; no genera Prisma ni lee DATABASE_URL. */
import 'reflect-metadata';
import { strict as assert } from 'assert';
import { randomInt, randomUUID } from 'crypto';
import { ProductsService } from '../src/products/products.service';
import { OrdersService } from '../src/products/orders.service';
import { LockersService } from '../src/products/lockers.service';

/** Puede ejecutarse sobre clientes independientes PostgreSQL o SQLite con el mismo esquema. */
export async function ejecutarPruebasPedidos(db: any, concurrencia = 16) {
  if (!Number.isInteger(concurrencia) || concurrencia < 3 || concurrencia > 200) throw new Error('Concurrencia de prueba entre 3 y 200');
  const prefijo = `pedidos-test-${randomUUID()}-`;
  const miembros: string[] = [];
  const productos: string[] = [];
  const casilleros: string[] = [];
  let numero = 100000 + randomInt(100000);
  let reciboFalla = false;
  const receipts = { emitir: async () => {
    if (reciboFalla) throw new Error('Falla simulada de comprobante');
    return { id: 'comprobante-ficticio' };
  } };
  const products = new ProductsService(db, receipts as any);
  const orders = new OrdersService(db, products);
  const conteo = (resultados: PromiseSettledResult<any>[]) => resultados.filter(r => r.status === 'fulfilled').length;
  async function denegado(promesa: Promise<unknown>) {
    try { await promesa; } catch (error) {
      assert.equal(error.getStatus?.(), 400, 'La colision devuelve un error de negocio, no un fallo de base');
      return;
    }
    assert.fail('La operacion debio rechazarse');
  }
  async function socio(sufijo: string) {
    const id = prefijo + sufijo;
    await db.member.create({ data: { id, dni: null, nombres: 'Prueba', apellidos: sufijo, pinHash: 'sin-login-en-pruebas', activo: true } });
    miembros.push(id);
    return id;
  }
  async function producto(sufijo: string, stock = 1, servicio = false, esCasillero = false) {
    const id = prefijo + sufijo;
    await db.product.create({ data: { id, nombre: sufijo, precio: 5, stock, esServicio: servicio, esCasillero } });
    productos.push(id);
    return id;
  }
  const vender = (productId: string, cantidad = 1) => products.vender({ items: [{ productId, cantidad }], metodo: 'efectivo' });
  const pedir = (memberId: string, productId: string) => orders.crear(memberId, { items: [{ productId, cantidad: 1 }] });

  try {
    const ultimaVenta = await producto('ultima-venta');
    const ventas = await Promise.allSettled(Array.from({ length: concurrencia }, () => vender(ultimaVenta)));
    assert.equal(conteo(ventas), 1, 'La ultima unidad se vende una sola vez');
    for (const r of ventas) if (r.status === 'rejected') assert.equal(r.reason.getStatus?.(), 400);
    assert.equal((await db.product.findUnique({ where: { id: ultimaVenta } })).stock, 0);
    assert.equal(await db.sale.count({ where: { items: { some: { productId: ultimaVenta } } } }), 1);
    assert.equal(await db.payment.count({ where: { sale: { items: { some: { productId: ultimaVenta } } } } }), 1, 'Solo existe un cobro');

    const duplicado = await producto('lineas-duplicadas');
    await denegado(products.vender({ items: [{ productId: duplicado, cantidad: 1 }, { productId: duplicado, cantidad: 1 }], metodo: 'efectivo' }));
    assert.equal((await db.product.findUnique({ where: { id: duplicado } })).stock, 1, 'Agregar lineas repetidas no salta el limite de stock');

    const ultimaReserva = await producto('ultima-reserva');
    const socios = await Promise.all(Array.from({ length: concurrencia }, (_, i) => socio(`socio-${i}`)));
    const reservas = await Promise.allSettled(socios.map(id => pedir(id, ultimaReserva)));
    assert.equal(conteo(reservas), 1, 'La ultima unidad se aparta una sola vez');
    for (const r of reservas) if (r.status === 'rejected') assert.equal(r.reason.getStatus?.(), 400);
    assert.equal((await db.product.findUnique({ where: { id: ultimaReserva } })).stock, 1, 'Apartar no descuenta inventario');
    await denegado(vender(ultimaReserva));
    assert.equal((await orders.tienda()).find(p => p.id === ultimaReserva).disponible, 0);

    const sinInventario = await producto('servicio-sin-stock', 0, true);
    const socioLimite = await socio('maximo-pendientes');
    const simultaneos = await Promise.allSettled(Array.from({ length: concurrencia }, () => pedir(socioLimite, sinInventario)));
    assert.equal(conteo(simultaneos), 2, 'Un socio conserva como maximo dos pedidos pendientes');
    for (const r of simultaneos) if (r.status === 'rejected') assert.equal(r.reason.getStatus?.(), 400);
    assert.equal(await db.order.count({ where: { memberId: socioLimite, estado: 'pendiente' } }), 2);

    const cobrandoProducto = await producto('reserva-cobrando');
    const socioCobrando = await socio('cobrando');
    const cobrando = await pedir(socioCobrando, cobrandoProducto);
    await db.order.update({ where: { id: cobrando.id }, data: { estado: 'cobrando', createdAt: new Date(Date.now() - 13 * 3600 * 1000) } });
    assert.equal((await orders.tienda()).find(p => p.id === cobrandoProducto).disponible, 0, 'Cobrando mantiene la reserva aunque el pedido sea antiguo');
    const socioSinPedidos = await socio('sin-pedidos');
    await denegado(pedir(socioSinPedidos, cobrandoProducto));
    await denegado(vender(cobrandoProducto));
    await pedir(socioCobrando, sinInventario);
    await denegado(pedir(socioCobrando, sinInventario));

    const entregaProducto = await producto('entrega-concurrente', 2);
    const socioEntrega = await socio('entrega');
    const socioOtraReserva = await socio('otra-reserva');
    const entregar = await pedir(socioEntrega, entregaProducto);
    await pedir(socioOtraReserva, entregaProducto);
    const entregas = await Promise.allSettled(Array.from({ length: concurrencia }, () => orders.entregar(entregar.id, 'efectivo', undefined)));
    assert.equal(conteo(entregas), 1, 'Recepcion entrega/cobra el pedido exactamente una vez');
    for (const r of entregas) if (r.status === 'rejected') assert.equal(r.reason.getStatus?.(), 400);
    const entregado = await db.order.findUnique({ where: { id: entregar.id } });
    assert.equal(entregado.estado, 'entregado');
    assert.ok(entregado.saleId);
    assert.equal((await db.product.findUnique({ where: { id: entregaProducto } })).stock, 1);
    assert.equal(await db.sale.count({ where: { items: { some: { productId: entregaProducto } } } }), 1);
    await denegado(vender(entregaProducto));
    assert.equal((await orders.tienda()).find(p => p.id === entregaProducto).disponible, 0, 'Se descuenta la reserva propia y se respeta la ajena');

    const falloProducto = await producto('comprobante-falla');
    const socioFallo = await socio('comprobante-falla');
    const falloPedido = await pedir(socioFallo, falloProducto);
    reciboFalla = true;
    const fallo = await orders.entregar(falloPedido.id, 'efectivo', undefined);
    reciboFalla = false;
    assert.match(fallo.errorComprobante, /Falla simulada/);
    assert.equal((await db.order.findUnique({ where: { id: falloPedido.id } })).estado, 'entregado');
    await denegado(orders.entregar(falloPedido.id, 'efectivo', undefined));
    assert.equal(await db.payment.count({ where: { sale: { items: { some: { productId: falloProducto } } } } }), 1, 'El error de comprobante no habilita un segundo cobro');

    const vencidoProducto = await producto('reserva-vencida');
    const socioVencido = await socio('reserva-vencida');
    const vencido = await pedir(socioVencido, vencidoProducto);
    await db.order.update({ where: { id: vencido.id }, data: { createdAt: new Date(Date.now() - 13 * 3600 * 1000) } });
    assert.equal((await orders.tienda()).find(p => p.id === vencidoProducto).disponible, 1);
    assert.equal((await orders.misPedidos(socioVencido))[0].estado, 'vencido');
    assert.ok(!(await orders.pendientes()).some(p => p.id === vencido.id));
    assert.equal((await db.order.findUnique({ where: { id: vencido.id } })).estado, 'pendiente', 'Las lecturas no escriben vencimientos');
    await denegado(orders.entregar(vencido.id, 'efectivo', undefined));
    await vender(vencidoProducto);

    const ajusteProducto = await producto('ajuste-reservado', 2);
    const socioAjuste = await socio('ajuste');
    await pedir(socioAjuste, ajusteProducto);
    await denegado(products.ajustarStock(ajusteProducto, -2));
    await products.ajustarStock(ajusteProducto, -1);
    await denegado(products.ajustarStock(ajusteProducto, -1));
    assert.equal((await db.product.findUnique({ where: { id: ajusteProducto } })).stock, 1);

    const socioLocker = await socio('casillero');
    const alquiler = await producto('alquiler', 0, true, true);
    const primerNumero = numero++;
    const segundoNumero = numero++;
    for (const n of [primerNumero, segundoNumero]) {
      const c = await db.locker.create({ data: { id: `${prefijo}casillero-${n}`, numero: n } });
      casilleros.push(c.id);
    }
    const alquileres = await Promise.allSettled([primerNumero, segundoNumero].map(casilleroNumero => products.vender({
      items: [{ productId: alquiler, cantidad: 1 }], metodo: 'efectivo', memberId: socioLocker, casilleroNumero,
    })));
    assert.equal(conteo(alquileres), 1, 'Un socio recibe un solo casillero durante cobros simultaneos');
    for (const r of alquileres) if (r.status === 'rejected') assert.equal(r.reason.getStatus?.(), 400);
    assert.equal(await db.locker.count({ where: { memberId: socioLocker } }), 1);

    const asignado = await db.locker.findUnique({ where: { memberId: socioLocker } });
    const reemplazo = new Date(asignado.ocupadoDesde.getTime() + 1000);
    const clienteConCarrera = {
      locker: { findUnique: async (args: any) => {
        const snapshot = await db.locker.findUnique(args);
        // Una salida y nueva asignacion terminan entre la lectura y el lock manual.
        await db.locker.update({ where: { id: asignado.id }, data: { ocupadoDesde: reemplazo } });
        return snapshot;
      } },
      $transaction: db.$transaction.bind(db),
    };
    await denegado(new LockersService(clienteConCarrera as any).liberar(asignado.numero));
    const conservado = await db.locker.findUnique({ where: { id: asignado.id } });
    assert.equal(conservado.memberId, socioLocker);
    assert.equal(conservado.ocupadoDesde.getTime(), reemplazo.getTime(), 'El CAS incluye la fecha para no liberar una nueva asignacion del mismo socio');
    await new LockersService(db).liberar(asignado.numero);
    assert.equal((await db.locker.findUnique({ where: { id: asignado.id } })).memberId, null);

    return { casos: 11, concurrencia, ok: true };
  } finally {
    // Solo filas creadas por esta llamada. No desconecta el cliente del llamador.
    const ventas = await db.sale.findMany({ where: { items: { some: { productId: { in: productos } } } }, select: { id: true } });
    const saleIds = ventas.map((v: any) => v.id);
    const pedidos = await db.order.findMany({ where: { memberId: { in: miembros } }, select: { id: true } });
    const orderIds = pedidos.map((p: any) => p.id);
    await db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.payment.deleteMany({ where: { saleId: { in: saleIds } } });
    await db.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
    await db.sale.deleteMany({ where: { id: { in: saleIds } } });
    await db.locker.deleteMany({ where: { id: { in: casilleros } } });
    await db.product.deleteMany({ where: { id: { in: productos } } });
    await db.member.deleteMany({ where: { id: { in: miembros } } });
  }
}
