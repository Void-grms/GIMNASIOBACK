/** Pruebas financieras sobre bases nuevas y locales; nunca usa DATABASE_URL del entorno. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
require('reflect-metadata');
const repo = path.resolve(__dirname, '..');
const { DailyPassService } = require('../dist/src/memberships/daily-pass.service');
const { DailyPassDto, DailyPassController } = require('../dist/src/memberships/daily-pass.controller');
const { MembersService } = require('../dist/src/members/members.service');
const { ReceiptsService } = require('../dist/src/receipts/receipts.service');
const { SettingsService } = require('../dist/src/settings/settings.service');
const { QrService } = require('../dist/src/qr/qr.service');
const { hoyLima, fechaFinDe, formatoFecha, sumarDias } = require('../dist/src/common/fechas');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const mode = process.argv[2] || 'sqlite';
assert(['sqlite', 'pg'].includes(mode));
const generatedRoot = mode === 'pg' ? path.join(repo, 'reports') : os.tmpdir();
fs.mkdirSync(generatedRoot, { recursive: true });
const tempRoot = fs.realpathSync.native(generatedRoot);
const tmp = fs.mkdtempSync(path.join(tempRoot, 'forcesgym-pase-diario-'));
const dbname = 'forcesgym_test_pase_' + Date.now();
assert(/^forcesgym_test_pase_\d+$/.test(dbname));
const url = mode === 'pg' ? `postgresql://postgres:forcesgym-local-tests@127.0.0.1:55438/${dbname}?connection_limit=8&pool_timeout=30` : 'file:' + path.join(tmp, 'test.db').replaceAll('\\', '/');
if (mode === 'pg') assert.equal(new URL(url).hostname, '127.0.0.1');
const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test', RUST_LOG: 'debug', RUST_BACKTRACE: '1', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' };
const cli = args => execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], { cwd: repo, env, stdio: 'pipe', timeout: 60000 });
const docker = args => execFileSync('docker', args, { stdio: 'pipe', timeout: 60000 });
const sql = command => docker(['exec', 'forcesgym-concurrency-20261015', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', command]);
let started = false, created = false, clients = [];
const checks = [];
const ok = name => { checks.push(name); console.log('ok ' + name); };
async function main() {
 try {
  if (mode === 'pg') {
   const wasRunning = docker(['inspect', '--format', '{{.State.Running}}', 'forcesgym-concurrency-20261015']).toString().trim() === 'true';
   if (!wasRunning) { docker(['start', 'forcesgym-concurrency-20261015']); started = true; }
   let ready = false;
   for (let intento = 0; intento < 40; intento++) {
    try { docker(['exec', 'forcesgym-concurrency-20261015', 'pg_isready', '-U', 'postgres']); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
   }
   assert(ready, 'PostgreSQL local debe estar listo antes de crear la base temporal');
   sql(`CREATE DATABASE ${dbname}`); created = true;
  }
  let schema = fs.readFileSync(path.join(repo, 'prisma/schema.prisma'), 'utf8').replace(/(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/, `$1"${mode === 'pg' ? 'postgresql' : 'sqlite'}"`);
  if (mode === 'pg') schema = schema.replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n output = "./cliente-pg"');
  const schemaPath = path.join(tmp, 'schema.prisma'); fs.writeFileSync(schemaPath, schema);
  if (mode === 'sqlite') fs.writeFileSync(path.join(tmp, 'test.db'), '');
  if (mode === 'pg') cli(['generate', '--schema', schemaPath]);
  cli(['db', 'push', '--schema', schemaPath, '--skip-generate']);
  const { PrismaClient } = mode === 'pg' ? require(path.join(tmp, 'cliente-pg')) : require('@prisma/client');
  clients = [new PrismaClient({ datasources: { db: { url } } }), new PrismaClient({ datasources: { db: { url } } })];
  const db = clients[0];
  await db.settings.create({ data: { id: 'default', ruc: '10180109531', razonSocial: 'EMISOR FICTICIO', terminosVersion: 'qa1', terminosTexto: 'Condiciones ficticias del pase por hoy.', consentimientoVersion: 'qa1', consentimientoTexto: 'Aceptación ficticia de datos personales.' } });
  await db.user.create({ data: { id: 'cajero-prueba', email: 'prueba@example.invalid', nombre: 'CAJERO FICTICIO', passwordHash: 'sin-acceso', rol: 'recepcion' } });
  await db.plan.create({ data: { id: 'plan-pase', nombre: 'Pase diario', precio: 8, duracionDias: 1 } });
  await db.plan.create({ data: { id: 'plan-mes', nombre: 'Mensual ficticio', precio: 60, duracionDias: 30, limiteAsistencias: 12 } });
  const qr = new QrService();
  const services = clients.map(client => { const settings = new SettingsService(client); const members = new MembersService(client, qr, settings); const receipts = new ReceiptsService(client, settings, { enviar: () => { throw Error('No debe llamar SUNAT/PSE'); } }); return { pases: new DailyPassService(client, members, receipts, settings), receipts, settings, members }; });
  const a = services[0].pases, b = services[1].pases;
  let serial = 0;
  const member = async (data = {}) => db.member.create({ data: { id: 'socio-' + (++serial), nombres: 'SOCIO', apellidos: 'FICTICIO ' + serial, pinHash: 'sin-acceso', ...data } });
  const body = async extra => { const o = await a.oferta(); return { operationId: randomUUID(), planId: o.plan.id, versionOferta: o.plan.versionOferta, montoEsperado: o.plan.precio, metodo: 'efectivo', aceptaTerminos: true, terminosVersion: o.legal.terminosVersion, terminosHuella: o.legal.terminosHuella, consentimiento: true, consentimientoVersion: o.legal.consentimientoVersion, consentimientoHuella: o.legal.consentimientoHuella, ...extra }; };
  const pay = (dto, service = a) => service.cobrar(dto, 'cajero-prueba', '127.0.0.1');
  const count = async () => Promise.all([db.member.count(), db.membership.count(), db.payment.count(), db.receipt.count(), db.checkIn.count(), db.consent.count()]);
  const rejects = (promise, code) => assert.rejects(() => promise, e => e.getResponse?.().codigo === code);
  const membership = (m, extra = {}) => db.membership.create({ data: { memberId: m.id, planId: 'plan-mes', fechaInicio: sumarDias(hoyLima(), -20), fechaFin: sumarDias(hoyLima(), 9), precioPagado: 60, limiteAsistencias: 12, ...extra } });
  const entry = (m, mid, minutes = 15, tipo = 'entrada') => db.checkIn.create({ data: { memberId: m.id, membershipId: mid, timestamp: new Date(Date.now() - minutes * 60000), tipo, metodo: 'manual', resultado: 'permitido' } });

  const offer = await a.oferta(); assert.equal(offer.disponible, true); assert.equal(offer.plan.precio, 8); assert.equal(offer.inicio, formatoFecha(hoyLima())); assert.equal(offer.inicio, offer.vence);
  assert(Reflect.getMetadata('__guards__', DailyPassController).some(x => x.name === 'SoloStaffGuard'));
  const dtoValido = plainToInstance(DailyPassDto, await body({ visitante: { nombre: 'VISITANTE PRUEBA' } }));
  const dtoLargo = plainToInstance(DailyPassDto, await body({ visitante: { nombre: 'x'.repeat(61) } }));
  assert.equal((await validate(dtoValido)).length, 0);
  assert((await validate(dtoLargo)).length > 0);
  ok('oferta real, vigencia por hoy, contrato DTO y endpoint exclusivo para personal');

  const visitorBody = await body({ visitante: { nombre: 'VISITANTE SIN DOCUMENTO' } });
  const visitor = await pay(visitorBody);
  const vm = await db.member.findUnique({ where: { id: visitor.memberId }, include: { credential: true, activacionesPortal: true } });
  assert.equal(vm.dni, null); assert.equal(vm.codigoERP, null); assert.equal(vm.apellidos, ''); assert.equal(vm.pinCambiado, false); assert.equal(vm.pinTemporalHasta, null); assert.equal(vm.credential, null); assert.equal(vm.activacionesPortal.length, 0); assert(!JSON.stringify(visitor).includes('pinHash'));
  assert.equal(visitor.monto, 8); assert.equal(visitor.comprobante.tipo, 'recibo'); assert.equal(visitor.comprobante.estadoSunat, 'no_aplica'); assert.equal(visitor.comprobante.total, 8); assert.equal(visitor.comprobante.paymentId, visitor.paymentId); assert.equal(visitor.ingreso.tipo, 'entrada'); assert.equal(visitor.inicio, visitor.vence);
  const vp = await db.payment.findUnique({ where: { id: visitor.paymentId } }); assert.equal(vp.cajeroId, 'cajero-prueba'); assert.equal(vp.concepto, 'membresia'); assert.equal(await db.consent.count({ where: { memberId: vm.id } }), 2);
  ok('visitante sin DNI: ficha mínima sin portal, cobro8, recibo interno, ingreso y consentimientos atómicos');

  const beforeReplay = await count(); await db.plan.update({ where: { id: 'plan-pase' }, data: { precio: 9 } }); await db.settings.update({ where: { id: 'default' }, data: { terminosTexto: 'Texto cambiado' } });
  const replay = await pay(visitorBody); assert.equal(replay.paymentId, visitor.paymentId); assert.equal(replay.repetida, true); assert.equal(replay.monto, 8); assert.deepEqual(await count(), beforeReplay);
  await rejects(pay({ ...visitorBody, metodo: 'yape' }), 'OPERACION_REUTILIZADA');
  await db.plan.update({ where: { id: 'plan-pase' }, data: { precio: 8 } }); await db.settings.update({ where: { id: 'default' }, data: { terminosTexto: 'Condiciones ficticias del pase por hoy.' } });
  ok('respuesta perdida/reintento recupera antes de precio/legal/ingreso; UUID distinto payload rechaza sin duplicar');

  const badPrice = await body({ visitante: { nombre: 'PRECIO PRUEBA' } }); const priceCounts = await count(); await db.plan.update({ where: { id: 'plan-pase' }, data: { precio: 9 } });
  await rejects(pay(badPrice), 'OFERTA_CAMBIADA'); assert.deepEqual(await count(), priceCounts); await db.plan.update({ where: { id: 'plan-pase' }, data: { precio: 8 } });
  const badLegal = await body({ visitante: { nombre: 'LEGAL PRUEBA' } }); const legalCounts = await count(); await db.settings.update({ where: { id: 'default' }, data: { consentimientoTexto: 'Legal cambiado' } });
  await rejects(pay(badLegal), 'LEGAL_CAMBIADO'); assert.deepEqual(await count(), legalCounts); await db.settings.update({ where: { id: 'default' }, data: { consentimientoTexto: 'Aceptación ficticia de datos personales.' } });
  ok('cambios de precio/oferta/texto legal devuelven409 sin dejar ficha, pagos ni entradas');

  const noConsent = await body({ visitante: { nombre: 'SIN ACEPTAR' }, consentimiento: false }); const noConsentCounts = await count(); await assert.rejects(() => pay(noConsent), e => e.getStatus?.() === 400); assert.deepEqual(await count(), noConsentCounts);
  const eliminadoBody = await body({ memberId: 'eliminado' });
  await assert.rejects(() => pay(eliminadoBody), e => e.getStatus?.() === 404);
  ok('consentimiento omitido o socio eliminado no generan cobro');

  const full = await member(); const fullMembership = await membership(full, { limiteAsistencias: null }); const fullCounts = await count();
  await rejects(pay(await body({ memberId: full.id })), 'COBERTURA_VIGENTE'); assert.deepEqual(await count(), fullCounts); assert.equal((await db.membership.findUnique({ where: { id: fullMembership.id } })).fechaFin.getTime(), fullMembership.fechaFin.getTime());
  const exhausted = await member(); const exMem = await membership(exhausted, { asistenciasUsadas: 12 }); const exPass = await pay(await body({ memberId: exhausted.id })); assert.equal(exPass.inicio, formatoFecha(hoyLima())); assert.equal((await db.membership.findUnique({ where: { id: exMem.id } })).asistenciasUsadas, 12);
  const reentry = await member(); const reMem = await membership(reentry, { asistenciasUsadas: 12 }); await entry(reentry, reMem.id, 45); await entry(reentry, reMem.id, 15, 'salida'); const reCounts = await count();
  await rejects(pay(await body({ memberId: reentry.id })), 'COBERTURA_VIGENTE'); assert.deepEqual(await count(), reCounts);
  ok('no cobra membresía vigente/reingreso del mismo día; cupo agotado sin asistencia hoy permite pase y preserva contrato anterior');

  const future = await member(); const futureMem = await membership(future, { fechaInicio: sumarDias(hoyLima(), 2), fechaFin: sumarDias(hoyLima(), 31) });
  const arrival = await db.preCheckIn.create({ data: { memberId: future.id, expiresAt: new Date(Date.now() + 600000) } });
  const futurePass = await pay(await body({ memberId: future.id })); assert.equal(futurePass.inicio, formatoFecha(hoyLima())); assert.equal((await db.membership.findUnique({ where: { id: futureMem.id } })).fechaInicio.getTime(), futureMem.fechaInicio.getTime());
  const attended = await db.preCheckIn.findUnique({ where: { id: arrival.id } });
  assert.equal(attended.estado, 'confirmado'); assert.equal(attended.checkInId, futurePass.ingreso.checkInId);
  ok('pase diario inicia hoy sin desplazar ni alterar membresía futura');

  const dni = await member({ nombres: 'MARIA', apellidos: 'PRUEBA', dni: '89900001' }); const dnBefore = await db.member.count(); const dniPass = await pay(await body({ visitante: { nombre: 'María Prueba', dni: dni.dni } })); assert.equal(dniPass.memberId, dni.id); assert.equal(await db.member.count(), dnBefore); assert.equal((await db.member.findUnique({ where: { id: dni.id } })).nombres, 'MARIA');
  const mismatchCounts = await count(); await rejects(pay(await body({ visitante: { nombre: 'OTRA PERSONA', dni: dni.dni } })), 'DNI_EXISTENTE'); assert.deepEqual(await count(), mismatchCounts);
  ok('DNI existente se reutiliza sólo con nombre coincidente y nunca se sobreescribe');

  const stale = await member(); await entry(stale, null, 8 * 60); await db.locker.create({ data: { numero: 77, memberId: stale.id, ocupadoDesde: new Date(Date.now() - 8 * 3600000) } });
  const stalePass = await pay(await body({ memberId: stale.id })); const staleEvents = await db.checkIn.findMany({ where: { memberId: stale.id }, orderBy: [{ timestamp: 'asc' }, { id: 'asc' }] }); assert.deepEqual(staleEvents.map(x => x.tipo), ['entrada', 'salida', 'entrada']); assert.equal(staleEvents[1].metodo, 'auto'); assert.equal(staleEvents[2].id, stalePass.ingreso.checkInId); assert.equal((await db.locker.findUnique({ where: { numero: 77 } })).memberId, null);
  const inside = await member(); await entry(inside, null, 10); const insideCounts = await count(); await rejects(pay(await body({ memberId: inside.id })), 'INGRESO_ABIERTO'); assert.deepEqual(await count(), insideCounts);
  ok('entrada olvidada8h cierra con política existente y libera casillero; ingreso reciente no vuelve a cobrar');

  const same = await member(); const sameBody = await body({ memberId: same.id }); const sameResults = await Promise.all([pay(sameBody, a), pay(sameBody, b)]); assert.equal(sameResults[0].paymentId, sameResults[1].paymentId); assert.equal(await db.payment.count({ where: { memberId: same.id } }), 1); assert.equal(await db.receipt.count({ where: { paymentId: sameResults[0].paymentId } }), 1); assert.equal(await db.checkIn.count({ where: { memberId: same.id, tipo: 'entrada' } }), 1);
  const concurrentVisitorBody = await body({ visitante: { nombre: 'VISITANTE CONCURRENTE' } }); const concurrentVisitors = await Promise.all([pay(concurrentVisitorBody, a), pay(concurrentVisitorBody, b)]); assert.equal(concurrentVisitors[0].memberId, concurrentVisitors[1].memberId); assert.equal(concurrentVisitors[0].paymentId, concurrentVisitors[1].paymentId);
  ok('dos clientes concurrentes con mismo UUID recuperan exactamente un pago/recibo/entrada/ficha');

  const different = await member(); const races = await Promise.allSettled([pay(await body({ memberId: different.id }), a), pay(await body({ memberId: different.id }), b)]); assert.equal(races.filter(x => x.status === 'fulfilled').length, 1); assert.equal(await db.payment.count({ where: { memberId: different.id } }), 1);
  const names = [{ nombre: 'MISMA IDENTIDAD', dni: '89900002' }, { nombre: 'Misma Identidad', dni: '89900002' }]; const dnis = await Promise.allSettled([pay(await body({ visitante: names[0] }), a), pay(await body({ visitante: names[1] }), b)]); assert.equal(dnis.filter(x => x.status === 'fulfilled').length, 1); assert.equal(await db.member.count({ where: { dni: '89900002' } }), 1);
  ok('UUID diferentes de la misma persona no cobran doble; colisión DNI no duplica persona');

  const rollbackBody = await body({ visitante: { nombre: 'FALLO RECIBO' } }); const rollbackCounts = await count(); const broken = new DailyPassService(db, services[0].members, { emitirInternoEnTransaccion: async () => { throw Error('Fallo simulado de recibo'); } }, services[0].settings);
  await assert.rejects(() => pay(rollbackBody, broken), /Fallo simulado/); assert.deepEqual(await count(), rollbackCounts); const recovered = await pay(rollbackBody); assert.equal(recovered.monto, 8);
  ok('fallo de recibo revierte ficha, contrato, pago, ingreso y legal; mismo UUID puede recuperarse sin duplicar');

  const invalidOffer = await body({ visitante: { nombre: 'PLAN INACTIVO' } }); await db.plan.update({ where: { id: 'plan-pase' }, data: { activo: false } }); assert.equal((await a.oferta()).disponible, false); const disabledCounts = await count(); await rejects(pay(invalidOffer), 'OFERTA_CAMBIADA'); assert.deepEqual(await count(), disabledCounts);
  ok('sin plan diario activo, oferta deshabilitada y POST rechaza sin cambios');

  const report = { passed: true, provider: mode, checks, pruebas: checks.length, alcance: 'Base nueva local desechable con datos ficticios; ninguna URL ni datos de producción.' };
  const reportPath = path.join(os.tmpdir(), 'forcesgym-pase-diario-' + mode + '-resultado.json'); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, pruebas: checks.length, provider: mode, reporte: reportPath }));
 } finally {
  await Promise.all(clients.map(c => c.$disconnect()));
  if (created) sql(`DROP DATABASE ${dbname} WITH (FORCE)`);
  if (started) docker(['stop', 'forcesgym-concurrency-20261015']);
  const resolved = fs.realpathSync.native(tmp); assert(resolved.startsWith(tempRoot + path.sep)); assert(path.basename(resolved).startsWith('forcesgym-pase-diario-'));
  try { fs.rmSync(resolved, { recursive: true, force: true }); }
  catch (error) {
   // Windows mantiene cargada la DLL del cliente generado hasta salir de Node.
   if (mode !== 'pg' || process.platform !== 'win32' || error.code !== 'EPERM') throw error;
   console.log(JSON.stringify({ limpiezaTrasSalir: resolved, motivo: 'Motor local de Prisma cargado por Windows hasta finalizar el proceso.' }));
  }
 }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
