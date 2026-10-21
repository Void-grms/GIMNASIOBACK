/** Integracion con bases aisladas: nunca usar datos reales del gimnasio. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckinsService } from '../src/checkins/checkins.service';
import { MembersService } from '../src/members/members.service';
import { MembershipsService } from '../src/memberships/memberships.service';
import { PlansController, CrearPlanDto, EditarPlanDto } from '../src/plans/plans.controller';
import { RenewalsService } from '../src/renewals/renewals.service';
import { QrService } from '../src/qr/qr.service';
import { congelarPlan } from '../src/plans/condiciones';
import { fechaFinDe, formatoFecha, hoyLima, MS_DIA, rangoDelDia, sumarDias } from '../src/common/fechas';

export async function probarMembresias(clientes: any[]) {
  assert(clientes.length >= 2, 'Usar dos clientes independientes');
  const db = clientes[0];
  const prefijo = `membresias-test-${randomUUID()}`;
  const ids = Array.from({ length: 9 }, (_, i) => `${prefijo}-socio-${i}`);
  const planId = `${prefijo}-plan`;
  const erpId = `erp_${prefijo}`;
  const qr = new QrService();
  const recibos: any[] = [];
  const servicios = clientes.map(cliente => {
    const members = new MembersService(cliente, qr, {} as any);
    // Este fixture no representa consentimiento ni crea comprobantes tributarios.
    members.registrarConsentimiento = async () => undefined;
    const memberships = new MembershipsService(cliente, { emitir: async (r: any) => { recibos.push(r); return null; } } as any, members);
    return { members, memberships, checkins: new CheckinsService(cliente, members, qr), plans: new PlansController(cliente), renewals: new RenewalsService(cliente, memberships, members) };
  });
  const a = servicios[0], b = servicios[1];
  const admin = { sub: 'admin-anonimo', tipo: 'staff', rol: 'admin' } as const;
  const recepcion = { sub: 'recepcion-anonima', tipo: 'staff', rol: 'recepcion' } as const;
  const hoy = hoyLima();
  const antiguo = (minutos: number) => new Date(Date.now() - minutos * 60_000);
  let pruebas = 0;
  const ok = (texto: string) => { pruebas++; console.log(`ok ${texto}`); };
  const vender = (i: number, s = a, plan = planId) => s.memberships.vender({ memberId: ids[i], planId: plan, metodo: 'efectivo', aceptaTerminos: true, comprobante: { tipo: 'recibo', clienteTipoDoc: 'sin_documento' } });
  const retirar = async (id: string, membershipId: string) => db.checkIn.create({ data: { memberId: id, membershipId, tipo: 'salida', metodo: 'manual', resultado: 'permitido', timestamp: antiguo(1) } });
  try {
    await db.plan.create({ data: { id: planId, nombre: 'INTERDIARIA ANONIMA', precio: 60, duracionDias: 30, limiteAsistencias: 12, descripcion: 'Doce dias de entrenamiento', esPromocion: false } });
    await db.plan.create({ data: { id: erpId, nombre: 'HISTORICO ANONIMO', precio: 1, duracionDias: 30, activo: false } });
    for (const id of ids) await db.member.create({ data: { id, nombres: 'SOCIO ANONIMO', apellidos: 'PRUEBA', pinHash: 'cuenta-sin-acceso', portalVersion: 7 } });

    const valido = plainToInstance(CrearPlanDto, { nombre: '  Promocion verano  ', precio: 0, duracionDias: 15, limiteAsistencias: null, esPromocion: true });
    assert.equal((await validate(valido)).length, 0); assert.equal(valido.nombre, 'Promocion verano');
    for (const datos of [{ nombre: ' ', precio: 1, duracionDias: 30 }, { nombre: 'Promo', precio: -1, duracionDias: 30 }, { nombre: 'Promo', precio: 10.123, duracionDias: 30 }, { nombre: 'Promo', precio: 1, duracionDias: 0 }, { nombre: 'Promo', precio: 1, duracionDias: 30, limiteAsistencias: 0 }, { nombre: 'Promo', precio: 1, duracionDias: 30, limiteAsistencias: 1.5 }]) {
      assert((await validate(plainToInstance(CrearPlanDto, datos))).length > 0);
    }
    assert((await validate(plainToInstance(EditarPlanDto, { nombre: '  ' }))).length > 0);
    ok('validacion rechaza precios negativos o fraccionarios extra, cupos invalidos y nombre vacio; admite promocion gratuita');

    assert.throws(() => a.plans.crear(valido, recepcion), /Solo el administrador/);
    await assert.rejects(() => a.plans.editar(planId, { precio: 5 }, recepcion), /Solo el administrador/);
    await assert.rejects(() => a.plans.administrar(recepcion), /Solo el administrador/);
    await assert.rejects(() => a.plans.editar(erpId, { activo: true }, admin), /contratos importados/);
    assert.equal((await db.plan.findUnique({ where: { id: erpId } })).activo, false);
    ok('recepcion no gestiona el catalogo y planes historicos no se editan ni reactivan');

    const nuevo = await a.plans.crear({ ...valido, nombre: `${prefijo}-promocion` }, admin);
    assert.equal(nuevo.esPromocion, true); assert.equal(nuevo.limiteAsistencias, null);
    const listaPublica = await a.plans.publico();
    assert(listaPublica.some(p => p.id === nuevo.id)); assert(!listaPublica.some(p => p.id === erpId));
    assert(!('createdAt' in listaPublica.find(p => p.id === nuevo.id)));
    await a.plans.editar(nuevo.id, { activo: false }, admin);
    assert(!(await a.plans.listar()).some(p => p.id === nuevo.id));
    assert((await a.plans.administrar(admin, 'inactivos', prefijo)).some(p => p.id === nuevo.id));
    await a.plans.editar(nuevo.id, { activo: true, limiteAsistencias: 5 }, admin);
    assert.equal((await db.plan.findUnique({ where: { id: nuevo.id } })).limiteAsistencias, 5);
    await db.plan.delete({ where: { id: nuevo.id } });
    ok('alta, edicion, desactivacion y reactivacion reflejadas en catalogos publico y administrativo');

    const comprada = await vender(0);
    assert.equal(comprada.precioPagado, 60); assert.equal(comprada.limiteAsistencias, 12);
    assert.equal(comprada.asistenciasUsadas, 0); assert.equal(comprada.duracionDiasContratada, 30);
    assert.equal((comprada.fechaFin.getTime() - comprada.fechaInicio.getTime()) / MS_DIA, 29);
    assert.match(recibos.at(-1).items[0].descripcion, /12 asistencias/);
    await a.plans.editar(planId, { nombre: 'OTRO NOMBRE', precio: 75, duracionDias: 15, limiteAsistencias: 5, descripcion: 'Otras condiciones' }, admin);
    const historial = await a.memberships.listarDeSocio(ids[0]);
    assert.equal(historial[0].plan.nombre, 'INTERDIARIA ANONIMA'); assert.equal(historial[0].plan.duracionDias, 30);
    assert.equal(historial[0].plan.descripcion, 'Doce dias de entrenamiento'); assert.equal(historial[0].limiteAsistencias, 12);
    assert.equal((await a.members.obtener(ids[0])).plan, 'INTERDIARIA ANONIMA');
    ok('compra congela precio, nombre, descripcion, vigencia y cupo; editar no altera contrato ni historial');

    const legado = await db.membership.create({ data: { memberId: ids[1], planId, fechaInicio: hoy, fechaFin: fechaFinDe(hoy, 10), precioPagado: 21 } });
    await a.plans.editar(planId, { nombre: 'CAMBIO POSTERIOR', limiteAsistencias: 2 }, admin);
    const legadoDespues = await db.membership.findUnique({ where: { id: legado.id } });
    assert.equal(legadoDespues.planNombre, 'OTRO NOMBRE'); assert.equal(legadoDespues.duracionDiasContratada, 10); assert.equal(legadoDespues.limiteAsistencias, null);
    ok('primer cambio congela contratos nativos previos y mantiene su acceso ilimitado');

    await a.plans.editar(planId, { nombre: 'INTERDIARIA ANONIMA', precio: 60, duracionDias: 30, limiteAsistencias: 12 }, admin);
    await db.membership.update({ where: { id: comprada.id }, data: { asistenciasUsadas: 11 } });
    const futuro = await vender(0);
    assert.equal(futuro.fechaInicio.getTime(), sumarDias(comprada.fechaFin, 1).getTime());
    const escaneos = await Promise.all([a.checkins.registrar({ id: ids[0] }, 'manual'), b.checkins.registrar({ id: ids[0] }, 'manual')]);
    assert.deepEqual(escaneos.map(r => r.resultado).sort(), ['permitido', 'repetido']);
    assert(escaneos.every(r => r.socio.membresiaId === comprada.id && r.socio.asistenciasRestantes === 0));
    assert.equal((await db.membership.findUnique({ where: { id: comprada.id } })).asistenciasUsadas, 12);
    assert.equal((await db.membership.findUnique({ where: { id: futuro.id } })).asistenciasUsadas, 0);
    ok('dos clientes simultaneos consumen la ultima asistencia una sola vez y no usan renovacion futura');

    const entrada = escaneos[0].checkInId;
    await db.checkIn.update({ where: { id: entrada }, data: { timestamp: antiguo(4) } });
    const salida = await a.checkins.registrar({ id: ids[0] }, 'manual');
    assert.equal(salida.resultado, 'permitido'); assert.equal(salida.tipo, 'salida');
    await db.checkIn.update({ where: { id: salida.checkInId }, data: { timestamp: antiguo(1) } });
    const reingreso = await b.checkins.registrar({ id: ids[0] }, 'manual');
    assert.equal(reingreso.resultado, 'permitido'); assert.equal(reingreso.tipo, 'entrada');
    assert.equal((await db.membership.findUnique({ where: { id: comprada.id } })).asistenciasUsadas, 12);
    ok('salir con cupo agotado es posible y reingreso del mismo dia no consume otra asistencia');

    await db.checkIn.updateMany({ where: { memberId: ids[0], resultado: 'permitido', tipo: 'entrada' }, data: { timestamp: sumarDias(rangoDelDia(hoy).inicio, -1) } });
    await retirar(ids[0], comprada.id);
    const denegadas = await Promise.all([a.checkins.registrar({ id: ids[0] }, 'manual'), b.checkins.registrar({ id: ids[0] }, 'manual')]);
    assert(denegadas.every(r => r.resultado === 'denegado' && /agotadas/.test(r.motivo)));
    assert.equal((await db.membership.findUnique({ where: { id: comprada.id } })).asistenciasUsadas, 12);
    ok('dia siguiente bloquea asistencia numero trece y deja traza sin consumir cuota futura');

    const agotada = await vender(2);
    await db.membership.update({ where: { id: agotada.id }, data: { asistenciasUsadas: 12 } });
    const preview = await a.memberships.previsualizar(ids[2], planId);
    assert.equal(preview.inicio, formatoFecha(hoy));
    const renovada = await vender(2);
    assert.equal(renovada.fechaInicio.getTime(), hoy.getTime()); assert.equal(renovada.asistenciasUsadas, 0);
    const encolada = await a.memberships.previsualizar(ids[0], planId);
    assert.equal(encolada.inicio, formatoFecha(sumarDias(futuro.fechaFin, 1)));
    ok('renovar cupo agotado empieza hoy; una renovacion ya futura mantiene la cola y preview coincide');

    const fallo = await vender(3);
    const clienteFallido = new Proxy(db, { get(target, prop) {
      if (prop !== '$transaction') return Reflect.get(target, prop);
      return (trabajo: any, opciones: any) => target.$transaction((tx: any) => trabajo(new Proxy(tx, { get(t, campo) {
        if (campo !== 'checkIn') return Reflect.get(t, campo);
        return new Proxy(t.checkIn, { get(modelo, operacion) { if (operacion === 'create') return async () => { throw new Error('Fallo controlado de asistencia'); }; return Reflect.get(modelo, operacion); } });
      } })), opciones);
    } });
    await assert.rejects(() => new CheckinsService(clienteFallido, a.members, qr).registrar({ id: ids[3] }, 'manual'), /Fallo controlado/);
    assert.equal((await db.membership.findUnique({ where: { id: fallo.id } })).asistenciasUsadas, 0);
    ok('fallo de escritura revierte cuota y no registra una asistencia incompleta');

    const pendiente = await db.renewalRequest.create({ data: { memberId: ids[4], planId, monto: 60, comprobante: 'fixture-sin-imagen', ...congelarPlan(await db.plan.findUnique({ where: { id: planId } })) } });
    await a.plans.editar(planId, { activo: false, nombre: 'PROMOCION DESACTIVADA', duracionDias: 10, limiteAsistencias: 3, precio: 99 }, admin);
    await a.renewals.aprobar(pendiente.id, undefined);
    const aprobada = await db.renewalRequest.findUnique({ where: { id: pendiente.id } });
    const contrato = await db.membership.findUnique({ where: { id: aprobada.membershipId } });
    assert.equal(contrato.planNombre, 'INTERDIARIA ANONIMA'); assert.equal(contrato.precioPagado, 60); assert.equal(contrato.duracionDiasContratada, 30); assert.equal(contrato.limiteAsistencias, 12);
    await assert.rejects(() => vender(5), /inactivo/);
    ok('Yape pendiente conserva oferta incluso tras desactivar; nuevas ventas del plan desactivado se rechazan');

    await db.membership.create({ data: { memberId: ids[6], planId: erpId, codigoERP: `${prefijo}-historico`, fechaInicio: hoy, fechaFin: fechaFinDe(hoy, 30), precioPagado: 1 } });
    const migrado = await a.checkins.registrar({ id: ids[6] }, 'manual');
    assert.equal(migrado.resultado, 'permitido'); assert.equal(migrado.socio.limiteAsistencias, null);
    assert.equal((await db.member.findUnique({ where: { id: ids[6] } })).portalVersion, 7);
    ok('contrato importado sigue vigente aunque su plan este inactivo y no recibe cupos retroactivos');

    await a.plans.editar(planId, { activo: true, nombre: 'INTERDIARIA ANONIMA', precio: 60, duracionDias: 30, limiteAsistencias: 12 }, admin);
    const ventas = await Promise.all([vender(7, a), vender(7, b)]);
    const ordenadas = ventas.sort((x, y) => x.fechaInicio.getTime() - y.fechaInicio.getTime());
    assert.equal(ordenadas[0].fechaInicio.getTime(), hoy.getTime());
    assert.equal(ordenadas[1].fechaInicio.getTime(), sumarDias(ordenadas[0].fechaFin, 1).getTime());
    assert.equal(await db.payment.count({ where: { memberId: ids[7] } }), 2);
    ok('ventas concurrentes al mismo socio conservan dos pagos y periodos sin solapamiento');

    const [concurrente] = await Promise.all([
      vender(8, a), b.plans.editar(planId, { nombre: 'OFERTA NUEVA', precio: 70, duracionDias: 20, limiteAsistencias: 8 }, admin),
    ]);
    const condiciones = [concurrente.planNombre, concurrente.precioPagado, concurrente.duracionDiasContratada, concurrente.limiteAsistencias];
    assert([['INTERDIARIA ANONIMA', 60, 30, 12], ['OFERTA NUEVA', 70, 20, 8]].some(opcion => JSON.stringify(opcion) === JSON.stringify(condiciones)));
    ok('editar catalogo durante una venta entrega una oferta completa y coherente, sin mezclar condiciones');

    const diario = await db.plan.create({ data: { id: `${prefijo}-diario`, nombre: `${prefijo}-pase`, precio: 8, duracionDias: 1 } });
    const nuevaActual = await vender(3, a, diario.id);
    const pase = await a.checkins.registrar({ id: ids[3] }, 'manual');
    assert.equal(pase.resultado, 'permitido'); assert.equal(pase.socio.membresiaId, nuevaActual.id);
    assert.equal((await a.members.obtener(ids[3])).membresiaId, nuevaActual.id);
    ok('pase diario recien comprado se usa hoy incluso si otro contrato vence mas tarde');

    const mensualSinCupo = await db.plan.create({ data: { id: `${prefijo}-mensual`, nombre: `${prefijo}-mensual`, precio: 100, duracionDias: 30 } });
    const promocion = await db.plan.create({ data: { id: `${prefijo}-promo7`, nombre: `${prefijo}-promo7`, precio: 20, duracionDias: 7, limiteAsistencias: 3, esPromocion: true } });
    await db.membership.updateMany({ where: { memberId: ids[5] }, data: { estado: 'anulada' } });
    const agotadaLarga = await vender(5, a);
    await db.membership.update({ where: { id: agotadaLarga.id }, data: { asistenciasUsadas: agotadaLarga.limiteAsistencias } });
    const promoCorta = await vender(5, a, promocion.id);
    assert.equal(promoCorta.fechaInicio.getTime(), hoy.getTime());
    assert(promoCorta.fechaFin < agotadaLarga.fechaFin);
    const previewTercera = await a.memberships.previsualizar(ids[5], promocion.id);
    assert.equal(previewTercera.inicio, formatoFecha(sumarDias(promoCorta.fechaFin, 1)));
    const tercera = await vender(5, a, promocion.id);
    assert.equal(tercera.fechaInicio.getTime(), sumarDias(promoCorta.fechaFin, 1).getTime());
    assert.equal((await a.memberships.previsualizar(ids[5], promocion.id)).inicio, formatoFecha(sumarDias(tercera.fechaFin, 1)));
    ok('contrato largo agotado no tapa promocion corta actual ni su siguiente periodo futuro');

    await db.membership.updateMany({ where: { memberId: ids[1] }, data: { estado: 'anulada' } });
    const mensualComprada = await vender(1, a, mensualSinCupo.id);
    await vender(1, a, diario.id);
    assert.equal((await a.memberships.previsualizar(ids[1], mensualSinCupo.id)).inicio, formatoFecha(sumarDias(mensualComprada.fechaFin, 1)));
    const mensualRenovada = await vender(1, a, mensualSinCupo.id);
    assert.equal(mensualRenovada.fechaInicio.getTime(), sumarDias(mensualComprada.fechaFin, 1).getTime());
    ok('pase diario no acorta la cola pagada de una membresia mensual ilimitada');

    const clienteYape = new Proxy(db, { get(target, prop) {
      if (prop === 'settings') return { findUnique: async () => ({ yapeNumero: '900000000' }) };
      return Reflect.get(target, prop);
    } });
    const renewalsVersionadas = new RenewalsService(clienteYape, a.memberships, a.members);
    for (const cambio of [{ precio: 80 }, { limiteAsistencias: 9 }]) {
      const ofertaVista = await a.memberships.previsualizar(ids[8], planId);
      const pagosAntes = await db.payment.count({ where: { memberId: ids[8] } });
      const solicitudesAntes = await db.renewalRequest.count({ where: { memberId: ids[8] } });
      await a.plans.editar(planId, cambio, admin);
      await assert.rejects(() => a.memberships.vender({ memberId: ids[8], planId, metodo: 'efectivo', aceptaTerminos: true, versionOferta: ofertaVista.versionOferta }), (e: any) => e.getStatus?.() === 409);
      await assert.rejects(() => renewalsVersionadas.solicitar(ids[8], { planId, imagen: 'imagen-no-usada', aceptaTerminos: true, versionOferta: ofertaVista.versionOferta }), (e: any) => e.getStatus?.() === 409);
      assert.equal(await db.payment.count({ where: { memberId: ids[8] } }), pagosAntes);
      assert.equal(await db.renewalRequest.count({ where: { memberId: ids[8] } }), solicitudesAntes);
    }
    ok('cambiar precio o cupo invalida oferta vista y rechaza cobro/solicitud con409 sin crear pagos ni solicitudes');

    const ofertaActual = await a.memberships.previsualizar(ids[8], planId);
    const compraConVersion = await a.memberships.vender({ memberId: ids[8], planId, metodo: 'efectivo', aceptaTerminos: true, versionOferta: ofertaActual.versionOferta });
    assert.equal(compraConVersion.precioPagado, ofertaActual.precio);
    assert.equal(compraConVersion.limiteAsistencias, ofertaActual.limiteAsistencias);
    ok('oferta confirmada vigente permite cobrar exactamente sus condiciones');

    return { pruebas };
  } finally {
    // Todos los registros borrados pertenecen exclusivamente a este fixture anonimo.
    await db.membershipOperation.deleteMany({ where: { memberId: { in: ids } } });
    await db.membershipFreeze.deleteMany({ where: { membership: { memberId: { in: ids } } } });
    await db.member.deleteMany({ where: { id: { in: ids } } });
    await db.plan.deleteMany({ where: { OR: [{ id: planId }, { id: erpId }, { nombre: { startsWith: prefijo } }] } });
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gimnasio-membresias-'));
  const database = `file:${path.join(tmp, 'test.db').replace(/\\/g, '/')}`;
  const clientes = [new PrismaClient({ datasources: { db: { url: database } } }), new PrismaClient({ datasources: { db: { url: database } } })];
  try {
    assert.equal((clientes[0] as any)._engineConfig.activeProvider, 'sqlite', 'Usar cliente SQLite en runner local; probarMembresias acepta clientes PG aislados');
    const schema = (await fs.readFile(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf8')).replace(/(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/, '$1"sqlite"');
    const schemaPath = path.join(tmp, 'schema.prisma');
    await fs.writeFile(schemaPath, schema);
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema', schemaPath, '--skip-generate'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: database, RUST_LOG: 'debug', RUST_BACKTRACE: '1' }, stdio: 'pipe', timeout: 60000 });
    const resultado = await probarMembresias(clientes);
    console.log(`Membresias SQLite: ${resultado.pruebas} pruebas aprobadas con dos clientes.`);
  } finally {
    await Promise.all(clientes.map(c => c.$disconnect()));
    const resolved = path.resolve(tmp);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
