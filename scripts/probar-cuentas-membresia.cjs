/** Bases nuevas y locales; nunca conecta con los datos del gimnasio. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
require('reflect-metadata');
const repo = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'sqlite';
assert(['sqlite', 'pg'].includes(mode));
const testRoot = mode === 'pg' ? path.join(repo, 'reports') : os.tmpdir();
fs.mkdirSync(testRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(testRoot, 'forcesgym-cuentas-'));
const dbname = 'forcesgym_test_cuentas_' + Date.now();
assert(/^forcesgym_test_cuentas_\d+$/.test(dbname));
const url = mode === 'pg' ? `postgresql://postgres:forcesgym-local-tests@127.0.0.1:55438/${dbname}?connection_limit=8&pool_timeout=30` : 'file:' + path.join(tmp, 'test.db').replaceAll('\\', '/');
if (mode === 'pg') assert.equal(new URL(url).hostname, '127.0.0.1');
const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test', RUST_LOG: 'debug', RUST_BACKTRACE: '1', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
const cli = args => execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], { cwd: repo, env, stdio: 'pipe', timeout: 60000 });
const docker = args => execFileSync('docker', args, { stdio: 'pipe', timeout: 60000 });
const sql = command => docker(['exec', 'forcesgym-concurrency-20261015', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', command]);
let started = false, created = false, clients = [];
const checks = [];
const ok = name => { checks.push(name); console.log('ok ' + name); };
const code = n => e => e.getStatus?.() === n;
const codigo = n => e => e.getResponse?.().codigo === n;

async function main() {
 try {
  if (mode === 'pg') {
   const running = docker(['inspect', '--format', '{{.State.Running}}', 'forcesgym-concurrency-20261015']).toString().trim() === 'true';
   if (!running) { docker(['start', 'forcesgym-concurrency-20261015']); started = true; }
   let ready = false;
   for (let i = 0; i < 40; i++) { try { docker(['exec', 'forcesgym-concurrency-20261015', 'pg_isready', '-U', 'postgres']); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); } }
   assert(ready); sql(`CREATE DATABASE ${dbname}`); created = true;
  }
  let schema = fs.readFileSync(path.join(repo, 'prisma/schema.prisma'), 'utf8').replace(/(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/, `$1"${mode === 'pg' ? 'postgresql' : 'sqlite'}"`);
  if (mode === 'pg') schema = schema.replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n output = "./cliente-pg"');
  const schemaPath = path.join(tmp, 'schema.prisma'); fs.writeFileSync(schemaPath, schema);
  if (mode === 'sqlite') fs.writeFileSync(path.join(tmp, 'test.db'), '');
  if (mode === 'pg') cli(['generate', '--schema', schemaPath]);
  cli(['db', 'push', '--schema', schemaPath, '--skip-generate']);
  process.env.DATABASE_URL = url;
  const { PrismaClient } = mode === 'pg' ? require(path.join(tmp, 'cliente-pg')) : require('@prisma/client');
  clients = [new PrismaClient({ datasources: { db: { url } } }), new PrismaClient({ datasources: { db: { url } } })];
  const db = clients[0];
  const { MembershipsService } = require('../dist/src/memberships/memberships.service');
  const { DailyPassService } = require('../dist/src/memberships/daily-pass.service');
  const { MembersService } = require('../dist/src/members/members.service');
  const { CheckinsService } = require('../dist/src/checkins/checkins.service');
  const { ReceiptsService } = require('../dist/src/receipts/receipts.service');
  const { SettingsService } = require('../dist/src/settings/settings.service');
  const { PseService } = require('../dist/src/receipts/pse.service');
  const { QrService } = require('../dist/src/qr/qr.service');
  const { PortalService } = require('../dist/src/portal/portal.service');
  const { hoyLima, formatoFecha, sumarDias, MS_DIA, rangoDelDia } = require('../dist/src/common/fechas');
  const { versionOferta } = require('../dist/src/plans/condiciones');
  const hoy = hoyLima(), fecha = n => formatoFecha(sumarDias(hoy, n));
  await db.settings.create({ data: { id: 'default', ruc: '00000000000', razonSocial: 'EMISOR FICTICIO', terminosTexto: 'Condiciones ficticias para pruebas.', consentimientoTexto: 'Consentimiento ficticio para pruebas.' } });
  await db.user.create({ data: { id: 'cajero', email: 'cajero@example.invalid', nombre: 'CAJERO FICTICIO', passwordHash: 'sin-acceso', rol: 'recepcion' } });
  await db.user.create({ data: { id: 'entrenador', email: 'entrenador@example.invalid', nombre: 'ENTRENADOR FICTICIO', passwordHash: 'sin-acceso', rol: 'entrenador' } });
  await db.plan.create({ data: { id: 'mensual', nombre: 'MENSUAL FICTICIO', precio: 100, duracionDias: 30, limiteAsistencias: 12 } });
  await db.plan.create({ data: { id: 'diario', nombre: 'Pase diario', precio: 8, duracionDias: 1 } });
  const services = clients.map(client => {
    const qr = new QrService(), settings = new SettingsService(client), members = new MembersService(client, qr, settings);
    const receipts = new ReceiptsService(client, settings, new PseService());
    return { memberships: new MembershipsService(client, receipts, members), members, receipts, settings, checkins: new CheckinsService(client, members, qr), pases: new DailyPassService(client, members, receipts, settings), portal: new PortalService(client, members, qr, {}, {}) };
  });
  const a = services[0], b = services[1]; let serial = 0;
  const member = () => db.member.create({ data: { id: 'socio-' + (++serial), nombres: 'SOCIO FICTICIO', apellidos: String(serial), pinHash: 'sin-acceso', pinCambiado: true } });
  const body = async (m, extra = {}) => ({ operationId: randomUUID(), memberId: m.id, planId: 'mensual', versionOferta: versionOferta(await db.plan.findUnique({ where: { id: 'mensual' } })), metodo: 'efectivo', aceptaTerminos: true, cajeroId: 'cajero', comprobante: { tipo: 'recibo', clienteTipoDoc: 'sin_documento' }, ...extra });
  const pay = (dto, s = a) => s.memberships.vender(dto);
  const abonar = (mid, monto, extra = {}, s = a) => s.memberships.abonar(mid, { operationId: randomUUID(), monto, metodo: 'yape', ...extra }, 'cajero');
  const ajustar = (mid, version, inicio, extra = {}, s = a) => s.memberships.ajustarFechas(mid, { operationId: randomUUID(), fechaInicio: inicio, motivo: 'Corrección ficticia autorizada', aprobado: true, version, ...extra }, 'cajero');
  const congelar = (mid, version, desde, hasta, extra = {}, s = a) => s.memberships.congelar(mid, { operationId: randomUUID(), desde, hasta, motivo: 'Ausencia ficticia autorizada', aprobado: true, version, ...extra }, 'cajero');
  const counts = () => Promise.all([db.membership.count(), db.payment.count(), db.membershipOperation.count(), db.membershipFreeze.count(), db.consent.count()]);

  const m1 = await member(), ventaDto = await body(m1, { abonoInicial: 50, fechaLimiteSaldo: fecha(7) });
  const venta = await pay(ventaDto);
  assert.deepEqual([venta.cuenta.total, venta.cuenta.pagado, venta.cuenta.saldo, venta.cuenta.estado], [100, 50, 50, 'pendiente']);
  assert.equal(venta.precioPagado, 100); assert.equal(venta.totalContratadoCentimos, 10000); assert.equal(venta.comprobante.total, 50); assert.match(venta.comprobante.items[0].descripcion, /MENSUAL.*Abono/); assert.match(venta.comprobante.observacion, /Acumulado: S\/50.00. Saldo: S\/50.00/);
  assert.equal((await a.checkins.registrar({ id: m1.id }, 'manual')).resultado, 'permitido');
  assert.equal((await a.members.obtener(m1.id)).cuenta.saldo, 50); assert.equal((await a.members.buscar(m1.id.split('-')[1])).find(x => x.id === m1.id)?.cuenta?.saldo ?? (await a.members.membresiaVigente(m1.id)).payments[0].monto, 50);
  ok('abono inicial50/100 activa acceso, congela contrato, recibe50 y expone saldo50 sin duplicar ingresos');

  const antesReplay = await counts(), serieAntes = venta.comprobante.numero;
  await db.plan.update({ where: { id: 'mensual' }, data: { precio: 120, activo: false } });
  await db.settings.update({ where: { id: 'default' }, data: { terminosTexto: 'Condiciones cambiadas después del pago.' } });
  const replay = await pay(ventaDto, b); assert.equal(replay.repetida, true); assert.equal(replay.paymentId, venta.paymentId); assert.equal(replay.comprobante.numero, serieAntes); assert.deepEqual(await counts(), antesReplay);
  await assert.rejects(() => pay({ ...ventaDto, abonoInicial: 60 }), codigo('OPERACION_REUTILIZADA'));
  await db.plan.update({ where: { id: 'mensual' }, data: { precio: 100, activo: true } });
  ok('UUID inicial recupera respuesta tras cambios de catálogo/legal; otra carga no reutiliza operación ni correlativo');

  const abonoDto = { operationId: randomUUID(), monto: 50, metodo: 'tarjeta', comprobante: { tipo: 'boleta', clienteTipoDoc: 'sin_documento' } };
  const completada = await a.memberships.abonar(venta.id, abonoDto, 'cajero');
  assert.deepEqual([completada.cuenta.pagado, completada.cuenta.saldo, completada.cuenta.estado], [100, 0, 'pagada']); assert.equal(completada.inicio, venta.inicio); assert.equal(completada.vence, venta.vence);
  assert.equal(completada.comprobante.total, 50); assert.equal(completada.comprobante.tipo, 'boleta'); assert.equal(completada.comprobante.estadoSunat, 'no_aplica'); assert.match(completada.comprobante.observacion, /Acumulado: S\/100.00. Saldo: S\/0.00/);
  const suma = await db.payment.aggregate({ where: { membershipId: venta.id }, _sum: { monto: true } }); assert.equal(suma._sum.monto, 100);
  const abonosAntes = await counts(); assert.equal((await b.memberships.abonar(venta.id, abonoDto, 'cajero')).repetida, true); assert.deepEqual(await counts(), abonosAntes);
  await assert.rejects(() => abonar(venta.id, 1), codigo('SALDO_CAMBIADO'));
  assert.equal((await a.memberships.pendientes()).some(x => x.membershipId === venta.id), false);
  ok('completar saldo registra solo50, mantiene fechas, respeta boleta elegida y replay no duplica comprobantes');

  const m2 = await member(), parcial2 = await pay(await body(m2, { abonoInicial: 50, fechaLimiteSaldo: fecha(0) }));
  await db.membership.update({ where: { id: parcial2.id }, data: { fechaLimiteSaldo: sumarDias(hoy, -1) } });
  assert.equal((await a.memberships.cuenta(parcial2.id)).estado, 'vencida'); assert.equal((await a.checkins.registrar({ id: m2.id }, 'manual')).resultado, 'permitido');
  const concurrentes = await Promise.allSettled([abonar(parcial2.id, 40), abonar(parcial2.id, 40, {}, b)]);
  assert.equal(concurrentes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(concurrentes.filter(x => x.status === 'rejected' && codigo('SALDO_CAMBIADO')(x.reason)).length, 1); assert.equal((await a.memberships.cuenta(parcial2.id)).saldo, 10);
  const mismo = { operationId: randomUUID(), monto: 10, metodo: 'efectivo' };
  const carrera = await Promise.all([a.memberships.abonar(parcial2.id, mismo, 'cajero'), b.memberships.abonar(parcial2.id, mismo, 'cajero')]); assert.equal(new Set(carrera.map(x => x.paymentId)).size, 1); assert.equal((await a.memberships.cuenta(parcial2.id)).saldo, 0);
  assert.equal(await db.payment.count({ where: { membershipId: parcial2.id } }), 3);
  ok('dos cajeros no sobrecobran saldo; misma operación concurrente cobra una vez; deuda vencida solo informa');

  const m3 = await member(), beforeInvalid = await counts();
  for (const extra of [{ abonoInicial: 0, fechaLimiteSaldo: fecha(7) }, { abonoInicial: 101, fechaLimiteSaldo: fecha(7) }, { abonoInicial: 50 }, { abonoInicial: 50, fechaLimiteSaldo: '2026-02-30' }, { abonoInicial: 50, fechaLimiteSaldo: fecha(-1) }, { abonoInicial: 50, fechaLimiteSaldo: fecha(7), operationId: undefined }, { fechaInicio: fecha(-3), apruebaFechas: false, motivoFechas: 'Corrección ficticia' }, { fechaInicio: fecha(-3), apruebaFechas: true, motivoFechas: 'x' }, { inicioEsperado: fecha(9) }]) await assert.rejects(() => body(m3, extra).then(pay), e => [400, 409].includes(e.getStatus?.()));
  await assert.rejects(() => body(m3, { cajeroId: 'entrenador' }).then(pay), code(403));
  assert.deepEqual(await counts(), beforeInvalid);
  const originalTx = db.$transaction.bind(db);
  db.$transaction = (fn, options) => originalTx(tx => fn(new Proxy(tx, { get(target, p) { if (p === 'consent') return { create: async () => { throw Error('Fallo ficticio de consentimiento'); } }; return Reflect.get(target, p); } })), options);
  await assert.rejects(() => body(m3).then(pay), /Fallo ficticio/); db.$transaction = originalTx;
  assert.deepEqual(await counts(), beforeInvalid);
  ok('montos/plazo/aprobación/rol/fecha previa inválidos no escriben; fallo consentimiento revierte contrato y dinero');

  const retro = await pay(await body(m3, { fechaInicio: fecha(-5), motivoFechas: 'Alta ficticia omitida hace cinco días', apruebaFechas: true }));
  assert.equal(retro.inicio, fecha(-5)); assert.equal(retro.vence, fecha(24)); assert.equal(await db.checkIn.count({ where: { memberId: m3.id } }), 0);
  const originalFechaPago = retro.payments[0].fecha.toISOString(), originalRecibo = JSON.stringify(retro.comprobante);
  const ajusteDto = { operationId: randomUUID(), fechaInicio: fecha(7), motivo: 'Inicio futuro pactado con socio', aprobado: true, version: retro.cuenta.version };
  const futuro = await a.memberships.ajustarFechas(retro.id, ajusteDto, 'cajero'); assert.equal(futuro.inicio, fecha(7)); assert.equal(futuro.vence, fecha(36)); assert.equal(futuro.cuenta.ajustes.length, 2);
  assert.equal((await a.checkins.registrar({ id: m3.id }, 'manual')).resultado, 'denegado'); assert.equal((await a.members.obtener(m3.id)).inicioProgramado, true);
  assert.equal((await db.payment.findUnique({ where: { id: retro.paymentId } })).fecha.toISOString(), originalFechaPago); assert.equal(JSON.stringify(await a.receipts.obtener(retro.comprobante.id)), originalRecibo);
  assert.equal((await b.memberships.ajustarFechas(retro.id, ajusteDto, 'cajero')).repetida, true); await assert.rejects(() => ajustar(retro.id, 1, fecha(6)), codigo('VERSION_CAMBIADA'));
  ok('inicio pasado/futuro auditado conserva30 días inclusivos, no crea asistencias ni altera dinero/comprobante y rechaza versión vieja');

  const m4 = await member(), conUso = await pay(await body(m4));
  assert.equal((await a.checkins.registrar({ id: m4.id }, 'manual')).resultado, 'permitido');
  const countFechas = await counts(); await assert.rejects(() => ajustar(conUso.id, conUso.cuenta.version, fecha(2)), code(400)); await assert.rejects(() => congelar(conUso.id, conUso.cuenta.version, fecha(0), fecha(2)), code(400)); assert.deepEqual(await counts(), countFechas);
  const conUsoDb = await db.membership.findUnique({ where: { id: conUso.id } }); assert.equal(conUsoDb.asistenciasUsadas, 1);
  const pausaFutura = await congelar(conUso.id, conUso.cuenta.version, fecha(5), fecha(7)); assert.equal(pausaFutura.vence, fecha(32)); assert.equal(pausaFutura.cuenta.congelamientos[0].dias, 3);
  const adyacente = await congelar(conUso.id, pausaFutura.cuenta.version, fecha(8), fecha(9)); assert.equal(adyacente.vence, fecha(34)); await assert.rejects(() => congelar(conUso.id, adyacente.cuenta.version, fecha(7), fecha(8)), code(400));
  assert.equal((await db.membership.findUnique({ where: { id: conUso.id } })).asistenciasUsadas, 1);
  ok('asistencias usadas no se excluyen ni congelan; pausas inclusivas adyacentes suman5 sin regalar cuota ni duplicar días');

  const m5 = await member(), paraPausa = await pay(await body(m5));
  await db.membership.update({ where: { id: paraPausa.id }, data: { estado: 'vencida' } });
  const pausaDto = { operationId: randomUUID(), desde: fecha(0), hasta: fecha(6), motivo: 'Viaje ficticio aprobado por recepción', aprobado: true, version: paraPausa.cuenta.version };
  const pausada = await a.memberships.congelar(paraPausa.id, pausaDto, 'cajero'); assert.equal(pausada.vence, fecha(36)); assert.equal((await db.membership.findUnique({ where: { id: paraPausa.id } })).estado, 'activa');
  assert.equal((await a.checkins.registrar({ id: m5.id }, 'manual')).resultado, 'denegado');
  const visible = await a.portal.cuentas(m5.id); assert.equal(visible[0].pausada, true); assert.equal(visible[0].congelamientos.length, 1); assert(!JSON.stringify(visible).includes('Viaje ficticio')); assert(!JSON.stringify(visible).includes('cajero')); assert.equal((await a.portal.miPanel(m5.id)).pausaActualmente, true);
  const pas = await a.pases.oferta(); const ingresoPase = await a.pases.cobrar({ operationId: randomUUID(), memberId: m5.id, planId: pas.plan.id, versionOferta: pas.plan.versionOferta, montoEsperado: pas.plan.precio, metodo: 'efectivo', aceptaTerminos: true, terminosVersion: pas.legal.terminosVersion, terminosHuella: pas.legal.terminosHuella, consentimiento: true, consentimientoVersion: pas.legal.consentimientoVersion, consentimientoHuella: pas.legal.consentimientoHuella }, 'cajero');
  assert.equal(ingresoPase.ingreso.resultado, 'permitido'); assert.equal((await a.members.obtener(m5.id)).pausaActualmente, false);
  assert.equal((await a.memberships.congelar(paraPausa.id, pausaDto, 'cajero')).repetida, true); assert.equal((await a.memberships.cuenta(paraPausa.id)).congelamientos.length, 1);
  ok('pausa bloquea solo su contrato, otro pase permite acceso, replay no extiende otra vez, portal no filtra motivo/cajero');

  const m6 = await member(), primera = await pay(await body(m6)), segunda = await pay(await body(m6)); assert.equal(segunda.inicio, fecha(30));
  const antesSolape = await counts(); await assert.rejects(() => congelar(primera.id, primera.cuenta.version, fecha(5), fecha(7)), codigo('COBERTURA_SOLAPADA')); await assert.rejects(() => ajustar(segunda.id, segunda.cuenta.version, fecha(29)), codigo('COBERTURA_SOLAPADA')); assert.deepEqual(await counts(), antesSolape);
  ok('pausa que invade renovación pagada y cambio con solapamiento se rechazan sin efectos');

  const m7 = await member(), legacy = await db.membership.create({ data: { memberId: m7.id, planId: 'mensual', precioPagado: 35, fechaInicio: hoy, fechaFin: sumarDias(hoy, 29) } });
  const cuentaLegacy = await a.memberships.cuenta(legacy.id); assert.deepEqual([cuentaLegacy.total, cuentaLegacy.pagado, cuentaLegacy.saldo], [35, 35, 0]); await assert.rejects(() => abonar(legacy.id, 1), code(400));
  const m8 = await member(), anulada = await pay(await body(m8, { abonoInicial: 50, fechaLimiteSaldo: fecha(7) })); await a.memberships.anular(anulada.id, 'Anulación ficticia para revisión'); assert.equal((await a.memberships.pendientes()).find(x => x.membershipId === anulada.id).estadoMembresia, 'anulada'); await assert.rejects(() => abonar(anulada.id, 50), code(400)); await assert.rejects(() => ajustar(anulada.id, 2, fecha(1)), code(400));
  ok('contratos ERP sin movimientos no crean deudas, anular preserva saldo auditable y bloquea nuevos cargos/ajustes');

  const m9 = await member(), pagoPerdidoDto = await body(m9, { abonoInicial: 25, fechaLimiteSaldo: fecha(7) });
  const originalEmitir = a.receipts.emitir.bind(a.receipts); a.receipts.emitir = async () => { throw Error('Emisor ficticio sin conexión'); };
  const perdido = await pay(pagoPerdidoDto); assert.equal(perdido.cuenta.saldo, 75); assert.match(perdido.errorComprobante, /sin conexión/); a.receipts.emitir = originalEmitir;
  const recuperado = await pay(pagoPerdidoDto, b); assert.equal(recuperado.repetida, true); assert.equal(recuperado.comprobante.total, 25); assert.equal(await db.payment.count({ where: { memberId: m9.id } }), 1);
  ok('fallo de emisión conserva cobro y permite reemitir el mismo movimiento sin cobrar de nuevo');

  fs.writeFileSync(path.join(tmp, 'reporte.json'), JSON.stringify({ passed: true, mode, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, mode, checks: checks.length }));
 } finally {
  await Promise.all(clients.map(c => c.$disconnect()));
  if (created) sql(`DROP DATABASE ${dbname}`);
  if (started) docker(['stop', 'forcesgym-concurrency-20261015']);
  // El DLL de Prisma en Windows sigue cargado hasta que termina Node. Se dejan
  // los artefactos aislados para revisión; no se borra nada ajeno al fixture.
  console.log('Artefactos de prueba: ' + tmp);
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
