/** Pruebas con dos clientes/servicios independientes y una base aislada, nunca con datos del gimnasio. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CheckinsService } from '../src/checkins/checkins.service';
import { MembersService } from '../src/members/members.service';
import { QrService } from '../src/qr/qr.service';
import { hoyLima, sumarDias } from '../src/common/fechas';

/** Tambien admite clientes PostgreSQL del runner local con su propio schema anonimo. */
export async function probarConcurrenciaCheckins(clientes: any[]) {
  assert(clientes.length >= 2, 'Se necesitan al menos dos clientes de base independientes');
  const db = clientes[0];
  const qr = new QrService();
  const servicio = (cliente: any) => new CheckinsService(cliente, new MembersService(cliente, qr, {} as any), qr);
  const primero = servicio(clientes[0]);
  const segundo = servicio(clientes[1]);
  const prefijo = `checkins-test-${randomUUID()}`;
  const codigoBase = String(randomBytes(6).readUIntBE(0, 6));
  const ids = Array.from({ length: 7 }, (_, i) => `${prefijo}-${i}`);
  const numeros = [0, 1].map(i => randomInt(1_000_000, 2_000_000) + i);
  const lockerIds = numeros.map((_, i) => `${prefijo}-locker-${i}`);
  const planId = `${prefijo}-plan`;
  let pruebas = 0;
  const prueba = (nombre: string) => { pruebas++; console.log(`ok ${nombre}`); };
  const permitidos = (memberId: string) => db.checkIn.findMany({ where: { memberId, resultado: 'permitido' }, orderBy: { timestamp: 'asc' } });
  const ambos = <T>(trabajo: (s: CheckinsService) => Promise<T>) => Promise.all([trabajo(primero), trabajo(segundo)]);
  const edad = (minutos: number) => new Date(Date.now() - minutos * 60_000);
  const entrada = (memberId: string, minutos: number) => db.checkIn.create({ data: { memberId, tipo: 'entrada', metodo: 'manual', resultado: 'permitido', timestamp: edad(minutos) } });
  try {
    await db.plan.create({ data: { id: planId, nombre: 'PLAN ANONIMO DE PRUEBA', precio: 1, duracionDias: 30 } });
    for (const [i, id] of ids.entries()) {
      await db.member.create({ data: { id, codigoERP: `${codigoBase}${i}`, nombres: 'SOCIO ANONIMO', apellidos: 'PRUEBA CONCURRENCIA', dni: null, pinHash: 'cuenta-de-prueba-sin-acceso', portalVersion: 7,
        memberships: { create: { planId, fechaInicio: sumarDias(hoyLima(), -1), fechaFin: sumarDias(hoyLima(), 10), precioPagado: 1 } },
      } });
    }
    await db.consent.create({ data: { memberId: ids[0], tipo: 'datos_personales', version: 'test', texto: 'Consentimiento anonimo para fixture de prueba' } });
    await db.locker.createMany({ data: numeros.map((numero, i) => ({ id: lockerIds[i], numero })) });

    const scans = await ambos(s => s.escanear(`ERP:${codigoBase}0`, 'prueba-concurrente'));
    assert.deepEqual(scans.map(r => r.resultado).sort(), ['permitido', 'repetido']);
    assert(scans.every(r => r.tipo === 'entrada'));
    assert.equal(scans[0].checkInId, scans[1].checkInId);
    assert.equal((await permitidos(ids[0])).length, 1);
    assert(scans.every(r => r.socio.consentimientoPendiente === false));
    assert.equal((await db.member.findUnique({ where: { id: ids[0] } })).portalVersion, 7);
    prueba('dos scans simultaneos con clientes distintos producen una sola entrada y no alteran portal/consentimiento');

    await db.checkIn.update({ where: { id: scans[0].checkInId }, data: { timestamp: edad(1) } });
    assert.equal((await primero.escanear(`ERP:${codigoBase}0`)).resultado, 'repetido');
    assert.equal((await permitidos(ids[0])).length, 1);
    prueba('la ventana de tres minutos sigue impidiendo una salida accidental despues del rebote de treinta segundos');

    await db.checkIn.update({ where: { id: scans[0].checkInId }, data: { timestamp: edad(4) } });
    await db.locker.update({ where: { numero: numeros[0] }, data: { memberId: ids[0], ocupadoDesde: edad(4) } });
    const salidas = await ambos(s => s.escanear(`ERP:${codigoBase}0`));
    assert.deepEqual(salidas.map(r => r.resultado).sort(), ['permitido', 'repetido']);
    assert(salidas.every(r => r.tipo === 'salida'));
    assert.equal((await permitidos(ids[0])).length, 2);
    assert.equal(salidas.filter(r => r.casilleroLiberado === numeros[0]).length, 1);
    assert.equal((await db.locker.findUnique({ where: { numero: numeros[0] } })).memberId, null);
    prueba('dos scans de salida crean una sola salida y liberan el casillero una vez');

    const ultimaSalida = salidas[0].checkInId;
    await db.checkIn.update({ where: { id: ultimaSalida }, data: { timestamp: new Date(Date.now() - 29_000) } });
    assert.equal((await primero.escanear(`ERP:${codigoBase}0`)).resultado, 'repetido');
    await db.checkIn.update({ where: { id: ultimaSalida }, data: { timestamp: new Date(Date.now() - 31_000) } });
    assert.equal((await primero.escanear(`ERP:${codigoBase}0`)).resultado, 'permitido');
    assert.equal((await permitidos(ids[0])).length, 3);
    prueba('el rebote de treinta segundos sigue bloqueando un reingreso a los veintinueve y permite a los treinta y uno');

    const anuncios = await ambos(s => s.alternarPresencia(ids[1]));
    assert(anuncios.every(a => a.accion === 'entrada_anunciada'));
    const avisos = await db.preCheckIn.findMany({ where: { memberId: ids[1], estado: 'pendiente' } });
    assert.equal(avisos.length, 1);
    const confirmaciones = await Promise.allSettled([primero.confirmarLlegada(avisos[0].id), segundo.confirmarLlegada(avisos[0].id)]);
    assert.equal(confirmaciones.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(confirmaciones.filter(r => r.status === 'rejected').length, 1);
    const movimientosConfirmados = await permitidos(ids[1]);
    assert.equal(movimientosConfirmados.length, 1);
    assert.equal(movimientosConfirmados[0].tipo, 'entrada');
    const avisoConfirmado = await db.preCheckIn.findUnique({ where: { id: avisos[0].id } });
    assert.equal(avisoConfirmado.estado, 'confirmado');
    assert.equal(avisoConfirmado.checkInId, movimientosConfirmados[0].id);
    prueba('dos anuncios reutilizan un aviso y dos recepciones no consumen el mismo aviso dos veces');

    await db.checkIn.update({ where: { id: movimientosConfirmados[0].id }, data: { timestamp: edad(1) } });
    const portal = await ambos(s => s.alternarPresencia(ids[1], true));
    assert(portal.every(r => r.accion === 'salida_registrada' && !r.dentro));
    assert.equal((await permitidos(ids[1])).length, 2);
    assert.equal(await db.preCheckIn.count({ where: { memberId: ids[1], estado: 'pendiente' } }), 0);
    prueba('dos confirmaciones de salida del portal no crean una nueva llegada ni una segunda salida');

    const avisoExpirado = await db.preCheckIn.create({ data: { memberId: ids[2], tipo: 'entrada', expiresAt: edad(1) } });
    await assert.rejects(() => primero.confirmarLlegada(avisoExpirado.id), /atendido o expiro/);
    assert.equal((await permitidos(ids[2])).length, 0);
    prueba('un aviso vencido nunca crea una entrada aunque el cron no lo haya marcado expirado');

    const dentro = await entrada(ids[2], 5);
    await db.locker.update({ where: { numero: numeros[0] }, data: { memberId: ids[2], ocupadoDesde: edad(5) } });
    const clienteFallido = new Proxy(db, { get(target, prop) {
      if (prop !== '$transaction') return Reflect.get(target, prop);
      return (trabajo: any, opciones: any) => target.$transaction((tx: any) => trabajo(new Proxy(tx, { get(t, campo) {
        if (campo !== 'checkIn') return Reflect.get(t, campo);
        return new Proxy(t.checkIn, { get(modelo, operacion) {
          if (operacion === 'create') return async () => { throw new Error('Fallo controlado de escritura de asistencia'); };
          return Reflect.get(modelo, operacion);
        } });
      } })), opciones);
    } });
    await assert.rejects(() => servicio(clienteFallido).registrar({ id: ids[2] }, 'manual'), /Fallo controlado/);
    assert.equal((await db.locker.findUnique({ where: { numero: numeros[0] } })).memberId, ids[2]);
    assert.equal((await permitidos(ids[2])).length, 1);
    assert.equal((await permitidos(ids[2]))[0].id, dentro.id);
    prueba('si falla insertar la salida, se revierte tambien la liberacion del casillero');

    const avisoFallido = await db.preCheckIn.create({ data: { memberId: ids[3], tipo: 'entrada', expiresAt: new Date(Date.now() + 60_000) } });
    await assert.rejects(() => servicio(clienteFallido).confirmarLlegada(avisoFallido.id), /Fallo controlado/);
    assert.equal((await db.preCheckIn.findUnique({ where: { id: avisoFallido.id } })).estado, 'pendiente');
    assert.equal((await permitidos(ids[3])).length, 0);
    prueba('si falla insertar la entrada, el aviso permanece pendiente por rollback');

    const avisoCompetido = await db.preCheckIn.create({ data: { memberId: ids[6], tipo: 'entrada', expiresAt: new Date(Date.now() + 60_000) } });
    const atenciones = await Promise.allSettled([primero.confirmarLlegada(avisoCompetido.id), segundo.descartarLlegada(avisoCompetido.id)]);
    assert.equal(atenciones.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(atenciones.filter(r => r.status === 'rejected').length, 1);
    const atendido = await db.preCheckIn.findUnique({ where: { id: avisoCompetido.id } });
    assert.equal((await permitidos(ids[6])).length, atendido.estado === 'confirmado' ? 1 : 0);
    prueba('confirmar y descartar simultaneamente un aviso producen una sola decision consistente');

    await entrada(ids[4], 5);
    const entradasForzadas = await ambos(s => s.registrar({ id: ids[4] }, 'prechequeo', undefined, 'entrada'));
    assert(entradasForzadas.every(r => r.resultado === 'repetido' && r.tipo === 'entrada'));
    assert.equal((await permitidos(ids[4])).length, 1);
    prueba('una confirmacion forzada conserva la entrada existente incluso pasados tres minutos');

    const olvidada = await entrada(ids[5], 7 * 60);
    await db.locker.update({ where: { numero: numeros[1] }, data: { memberId: ids[5], ocupadoDesde: olvidada.timestamp } });
    // Ambas replicas reciben deliberadamente el mismo snapshot viejo; la decision debe revalidarse dentro del lock.
    primero.sociosDentro = segundo.sociosDentro = async () => [{ memberId: ids[5], desde: olvidada.timestamp }];
    await Promise.all([primero.cerrarSesionesOlvidadas(), segundo.cerrarSesionesOlvidadas(), primero.escanear(`ERP:${codigoBase}5`)]);
    const cerrados = await permitidos(ids[5]);
    assert.equal(cerrados.length, 2);
    assert.equal(cerrados.filter((r: any) => r.tipo === 'salida').length, 1);
    assert.equal((await db.locker.findUnique({ where: { numero: numeros[1] } })).memberId, null);
    prueba('dos cron y un scan simultaneos cierran una sola vez la sesion vieja');

    const salidaOlvidada = cerrados.find((r: any) => r.tipo === 'salida');
    await db.checkIn.update({ where: { id: salidaOlvidada.id }, data: { timestamp: edad(1) } });
    const reingreso = await segundo.escanear(`ERP:${codigoBase}5`);
    assert.equal(reingreso.tipo, 'entrada');
    await db.locker.update({ where: { numero: numeros[1] }, data: { memberId: ids[5], ocupadoDesde: new Date() } });
    await primero.cerrarSesionesOlvidadas();
    assert.equal((await permitidos(ids[5])).length, 3);
    assert.equal((await db.locker.findUnique({ where: { numero: numeros[1] } })).memberId, ids[5]);
    prueba('un snapshot anterior del cron no cierra una nueva sesion ni libera su nuevo casillero');

    await db.member.update({ where: { id: ids[3] }, data: { activo: false } });
    const denegado = await primero.registrar({ id: ids[3], activo: true }, 'manual');
    assert.equal(denegado.resultado, 'denegado');
    assert.match(denegado.motivo, /baja/);
    assert.equal((await permitidos(ids[3])).length, 0);
    prueba('registrar vuelve a leer el estado del socio dentro del lock y no usa una ficha desactualizada');
    return { pruebas };
  } finally {
    // Cada borrado esta limitado a identificadores anonimos creados por esta ejecucion.
    await db.locker.deleteMany({ where: { id: { in: lockerIds } } });
    await db.member.deleteMany({ where: { id: { in: ids } } });
    await db.plan.deleteMany({ where: { id: planId } });
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gimnasio-checkins-concurrencia-'));
  const database = `file:${path.join(tmp, 'test.db').replace(/\\/g, '/')}`;
  const clientes = [new PrismaClient({ datasources: { db: { url: database } } }), new PrismaClient({ datasources: { db: { url: database } } })];
  try {
    assert.equal((clientes[0] as any)._engineConfig.activeProvider, 'sqlite', 'El runner local requiere el cliente SQLite; para PostgreSQL usa clientes separados y probarConcurrenciaCheckins');
    const schema = (await fs.readFile(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf8')).replace(/(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/, '$1"sqlite"');
    const schemaPath = path.join(tmp, 'schema.prisma');
    await fs.writeFile(schemaPath, schema);
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--schema', schemaPath, '--skip-generate'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: database, RUST_LOG: 'debug', RUST_BACKTRACE: '1' }, stdio: 'pipe', timeout: 60000,
    });
    const resultado = await probarConcurrenciaCheckins(clientes);
    console.log(`Checkins SQLite: ${resultado.pruebas} pruebas de concurrencia aprobadas con dos clientes.`);
  } finally {
    await Promise.all(clientes.map(c => c.$disconnect()));
    const resolved = path.resolve(tmp);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
