/** Integracion con una SQLite temporal: nunca usa DATABASE_URL del entorno. */
import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';
import { MembersService } from '../src/members/members.service';
import { AccesoService } from '../src/members/acceso.service';
import { QrService } from '../src/qr/qr.service';
import { PortalService } from '../src/portal/portal.service';
import { PortalController } from '../src/portal/portal.controller';
import { IntentosService } from '../src/auth/intentos.service';
import { JwtGuard } from '../src/auth/jwt.guard';
import { hashToken } from '../src/members/acceso.util';

const baseTemporal = realpathSync(tmpdir());
const carpeta = realpathSync(mkdtempSync(join(baseTemporal, 'gym-acceso-test-')));
const repo = resolve(__dirname, '..');
const url = `file:${join(carpeta, 'acceso.sqlite').replace(/\\/g, '/')}`;
const esquema = join(repo, 'prisma', 'schema.prisma');
assert.ok(/provider\s*=\s*"sqlite"/.test(readFileSync(esquema, 'utf8')), 'Estas pruebas requieren el esquema SQLite local');
function prepararSQLite() {
  const argumentos = [join(repo, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--schema', esquema, '--skip-generate'];
  const envLocal = { ...process.env, DATABASE_URL: url };
  try { execFileSync(process.execPath, argumentos, { env: envLocal, stdio: 'pipe' }); }
  catch {
    // Prisma 5 en algunos Windows devuelve un error vacio al crear SQLite.
    // Activar diagnosticos en este proceso local evita ese fallo del motor.
    execFileSync(process.execPath, argumentos, { env: { ...envLocal, RUST_LOG: 'debug' }, stdio: 'pipe' });
  }
}
const prisma = new PrismaService({ datasources: { db: { url } } });
const settings = new SettingsService(prisma);
const qr = new QrService();
const members = new MembersService(prisma, qr, settings);
const acceso = new AccesoService(prisma, settings);
const jwt = new JwtService({ secret: 'secreto-local-de-pruebas-sin-datos-reales', signOptions: { expiresIn: '1h' } });
const portal = new PortalService(prisma, members, qr, jwt, new IntentosService(prisma));
const guard = new JwtGuard(jwt, new Reflector(), prisma);
const portalUrlPrevia = process.env.PORTAL_URL;
process.env.PORTAL_URL = 'http://localhost:3000/portal';

function contexto(token: string, metodo: keyof PortalController): ExecutionContext {
  return {
    getHandler: () => PortalController.prototype[metodo], getClass: () => PortalController,
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }),
  } as unknown as ExecutionContext;
}

async function denegado(fn: () => Promise<unknown>, status = 400) {
  await assert.rejects(fn, (e: any) => e instanceof HttpException && e.getStatus() === status);
}

function tokenInvitacion(enlace: string): string {
  return new URLSearchParams(new URL(enlace).hash.slice(1)).get('token')!;
}

let grupos = 0;
async function main() {
  prepararSQLite();
  await prisma.$connect();
  const ajustes = await settings.actualizar({ consentimientoTexto: 'Texto ficticio de consentimiento para las pruebas de integracion.' });
  const consentimientoVersion = ajustes.consentimientoVersion;
  const consentimientoHuella = createHash('sha256').update(ajustes.consentimientoTexto, 'utf8').digest('hex');
  const creado = await members.crear({ dni: '70128846', codigoERP: '1277', nombres: 'Socio', apellidos: 'Prueba', consentimiento: true });
  assert.ok(!('pinHash' in creado) && !('credential' in creado), 'El alta no expone hashes o secretos QR');
  assert.ok(creado.pinCambiado === false && /^\d{4}$/.test(creado.pinInicial), 'Alta emite PIN temporal aleatorio');
  assert.ok(creado.pinInicial !== '1277' && creado.pinInicial !== '8846', 'El PIN temporal no deriva de identificadores');
  const temporal = await portal.login(creado.dni, creado.pinInicial);
  assert.ok(temporal.debeCambiarPin && jwt.decode(temporal.access_token).debeCambiarPin, 'Sesion indica PIN pendiente');
  assert.ok(await guard.canActivate(contexto(temporal.access_token, 'miPanel')), 'Perfil permitido con PIN pendiente');
  await denegado(() => guard.canActivate(contexto(temporal.access_token, 'miQr')), 403);
  const minimo = await portal.miPanel(creado.id);
  assert.ok(!('pagos' in minimo) && !('ultimasVisitas' in minimo) && !('plan' in minimo), 'Perfil temporal no revela movimientos');
  await denegado(() => portal.actualizarPerfil(creado.id, { telefono: '999888777' }));
  await denegado(() => portal.actualizarPerfil(creado.id, { pinActual: creado.pinInicial, pinNuevo: '1277' }));
  await denegado(() => portal.actualizarPerfil(creado.id, { pinActual: creado.pinInicial, pinNuevo: '8846' }));
  const pinElegido = creado.pinInicial === '8642' ? '5826' : '8642';
  const cambiado = await portal.actualizarPerfil(creado.id, { pinActual: creado.pinInicial, pinNuevo: pinElegido }, jwt.decode(temporal.access_token).portalVersion);
  assert.ok('access_token' in cambiado && cambiado.access_token, 'Cambio PIN emite nueva sesion');
  await denegado(() => guard.canActivate(contexto(temporal.access_token, 'miPanel')), 401);
  assert.ok(await guard.canActivate(contexto(cambiado.access_token!, 'miQr')), 'Sesion renovada habilita portal');
  grupos++;

  await denegado(() => acceso.emitirPin(creado.id, { identidadVerificada: false }));
  const reset = await acceso.emitirPin(creado.id, { identidadVerificada: true });
  await denegado(() => guard.canActivate(contexto(cambiado.access_token!, 'miQr')), 401);
  const resetSesion = await portal.login(reset.dni, reset.pinInicial);
  await prisma.member.update({ where: { id: creado.id }, data: { pinTemporalHasta: new Date(Date.now() - 1000) } });
  await denegado(() => portal.login(reset.dni, reset.pinInicial), 401);
  await denegado(() => guard.canActivate(contexto(resetSesion.access_token, 'miPanel')), 401);
  const resetSinExpiry = await acceso.emitirPin(creado.id, { identidadVerificada: true });
  await prisma.member.update({ where: { id: creado.id }, data: { pinTemporalHasta: null } });
  await denegado(() => portal.login(resetSinExpiry.dni, resetSinExpiry.pinInicial), 401);
  grupos++;

  const importado = await prisma.member.create({ data: { dni: null, documentoERP: 'documento incompleto', codigoERP: '4001', nombres: 'Importado', apellidos: 'Prueba', pinHash: bcrypt.hashSync('5926', 10), pinCambiado: false } });
  await denegado(() => acceso.emitirPin(importado.id, { identidadVerificada: true, consentimiento: true, consentimientoVersion, consentimientoHuella }));
  await denegado(() => members.actualizar(importado.id, { dni: '70125528' }));
  await members.actualizar(importado.id, { dni: '70125528', identidadVerificada: true });
  await denegado(() => portal.login('70125528', '5926'), 401);
  await denegado(() => acceso.emitirPin(importado.id, { identidadVerificada: true }));
  await denegado(() => acceso.emitirPin(importado.id, { identidadVerificada: true, consentimiento: true, consentimientoVersion: 'texto-anterior' }));
  assert.ok(await prisma.consent.count({ where: { memberId: importado.id } }) === 0, 'Las denegaciones no fabrican consentimientos');
  const invitacionPendiente = await acceso.emitirActivacion(importado.id, { identidadVerificada: true });
  assert.ok(invitacionPendiente.enlaceBienvenida === 'http://localhost:3000/portal/bienvenida' && !invitacionPendiente.enlaceBienvenida.includes('#'), 'Bienvenida publica separada del enlace privado');
  assert.ok(invitacionPendiente.mensaje.includes('DNI') && invitacionPendiente.mensaje.includes('PIN personal') && invitacionPendiente.mensaje.includes('recepcion'), 'Mensaje explica cambio, acceso y continuidad de asistencia');
  assert.ok(await prisma.consent.count({ where: { memberId: importado.id } }) === 0, 'Emitir invitacion pendiente no fabrica consentimiento');
  const original = await prisma.member.findUniqueOrThrow({ where: { id: importado.id } });
  assert.ok(bcrypt.compareSync('5926', original.pinHash) && !original.pinCambiado, 'Invitar conserva PIN hasta consumo');
  const token = tokenInvitacion(invitacionPendiente.enlace);
  const metadata = await acceso.consultarActivacion(token);
  assert.ok(metadata.dniUltimos4 === '5528' && !('dni' in metadata) && !('token' in metadata), 'Consulta retorna identidad reducida');
  const guardado = await prisma.portalActivation.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
  assert.ok(guardado.tokenHash !== token && guardado.tokenHash.length === 64, 'Solo guarda SHA-256 del token');
  const dto = { token, dni: '70125528', pin: '5826', pinConfirmacion: '5826', consentimiento: true, consentimientoVersion, consentimientoHuella };
  await denegado(() => acceso.consumirActivacion({ ...dto, consentimiento: false }));
  await denegado(() => acceso.consumirActivacion({ ...dto, consentimientoVersion: 'obsoleto' }));
  await denegado(() => acceso.consumirActivacion({ ...dto, dni: '70129999' }));
  await denegado(() => acceso.consumirActivacion({ ...dto, pin: '1234', pinConfirmacion: '1234' }));
  await denegado(() => acceso.consumirActivacion({ ...dto, pin: '5528', pinConfirmacion: '5528' }));
  await denegado(() => acceso.consumirActivacion({ ...dto, pinConfirmacion: '8624' }));
  await settings.actualizar({ consentimientoTexto: 'Texto ficticio distinto, conservando la misma version.' });
  await denegado(() => acceso.consumirActivacion(dto));
  assert.ok(await prisma.consent.count({ where: { memberId: importado.id } }) === 0, 'Cambiar texto sin version no registra aceptacion con huella antigua');
  await settings.actualizar({ consentimientoTexto: ajustes.consentimientoTexto });
  assert.ok(!(await prisma.portalActivation.findUniqueOrThrow({ where: { id: guardado.id } })).usedAt, 'Errores no consumen invitacion');
  const carrera = await Promise.allSettled([acceso.consumirActivacion(dto), acceso.consumirActivacion(dto)]);
  assert.ok(carrera.filter((r) => r.status === 'fulfilled').length === 1, 'Solo un consumo concurrente puede completar');
  assert.ok(await prisma.consent.count({ where: { memberId: importado.id, origen: 'portal_activacion', version: consentimientoVersion, aceptado: true } }) === 1, 'Consumo registra aceptacion real una vez');
  const activado = await prisma.member.findUniqueOrThrow({ where: { id: importado.id } });
  assert.ok(activado.pinCambiado && activado.pinTemporalHasta === null && activado.portalVersion === original.portalVersion + 1, 'Consumo actualiza PIN y revoca versiones anteriores');
  assert.ok(bcrypt.compareSync('5826', activado.pinHash), 'Nuevo PIN funciona despues del consumo');
  await denegado(() => acceso.consumirActivacion(dto));
  await denegado(() => acceso.consultarActivacion(token));
  grupos++;

  const primera = await acceso.emitirActivacion(importado.id, { identidadVerificada: true });
  const segunda = await acceso.emitirActivacion(importado.id, { identidadVerificada: true });
  await denegado(() => acceso.consultarActivacion(tokenInvitacion(primera.enlace)));
  const activoAntes = await prisma.member.findUniqueOrThrow({ where: { id: importado.id } });
  assert.ok(activoAntes.portalVersion === activado.portalVersion && bcrypt.compareSync('5826', activoAntes.pinHash), 'Reemitir invitacion conserva PIN y sesiones vigentes');
  const segundoToken = tokenInvitacion(segunda.enlace);
  await prisma.portalActivation.update({ where: { tokenHash: hashToken(segundoToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await denegado(() => acceso.consultarActivacion(segundoToken));
  await denegado(() => acceso.consumirActivacion({ ...dto, token: segundoToken }));
  assert.ok((await prisma.member.findUniqueOrThrow({ where: { id: importado.id } })).portalVersion === activoAntes.portalVersion, 'Expiracion no cambia credenciales');
  grupos++;

  const sesionActiva = await portal.login('70125528', '5826');
  const pendienteDni = await acceso.emitirActivacion(importado.id, { identidadVerificada: true });
  await denegado(() => members.actualizar(importado.id, { dni: '70128846', identidadVerificada: true }));
  await denegado(() => members.actualizar(importado.id, { telefono: '999888777' }));
  const editado = await members.actualizar(importado.id, { dni: '70127728', telefono: '999888777', codigoERP: '4002', identidadVerificada: true });
  assert.ok(!('pinHash' in editado), 'Edicion no revela hashes');
  await denegado(() => guard.canActivate(contexto(sesionActiva.access_token, 'miQr')), 401);
  await denegado(() => acceso.consultarActivacion(tokenInvitacion(pendienteDni.enlace)));
  await denegado(() => portal.login('70125528', '5826'), 401);
  const ficha = await members.obtener(importado.id);
  assert.ok(!('pinHash' in ficha.socio) && ficha.socio.documentoERP === 'documento incompleto', 'Ficha conserva documento original sin hashes');
  const lista = await members.buscar('4002');
  assert.ok(lista.length === 1 && lista[0].codigoERP === '4002' && lista[0].consentimientoPendiente === false, 'Busqueda ERP devuelve estado de acceso y consentimiento');
  const siguiente = await acceso.emitirActivacion(importado.id, { identidadVerificada: true });
  const nuevaSesion = await portal.login('70127728', '5826');
  const anonimizado = await members.anonimizar(importado.id, 'prueba local');
  assert.ok(anonimizado.codigoERP === null && anonimizado.documentoERP === null && !('pinHash' in anonimizado), 'Anonimizacion elimina ERP y no expone credenciales');
  await denegado(() => guard.canActivate(contexto(nuevaSesion.access_token, 'miPanel')), 401);
  await denegado(() => acceso.consultarActivacion(tokenInvitacion(siguiente.enlace)));
  assert.ok(await prisma.portalActivation.count({ where: { memberId: importado.id } }) === 0, 'Anonimizar elimina invitaciones');
  grupos++;

  const pinConsentido = await prisma.member.create({ data: { dni: '70227728', codigoERP: '5001', nombres: 'Pendiente', apellidos: 'Consentimiento', pinHash: bcrypt.hashSync('5926', 10), pinCambiado: false } });
  await settings.actualizar({ consentimientoTexto: '' });
  await denegado(() => acceso.emitirPin(pinConsentido.id, { identidadVerificada: true, consentimiento: true, consentimientoVersion, consentimientoHuella }));
  await denegado(() => acceso.emitirActivacion(pinConsentido.id, { identidadVerificada: true, consentimiento: true, consentimientoVersion, consentimientoHuella }));
  assert.ok(await prisma.consent.count({ where: { memberId: pinConsentido.id } }) === 0, 'Texto vacio no registra consentimiento por PIN ni invitacion');
  await settings.actualizar({ consentimientoTexto: ajustes.consentimientoTexto });
  await acceso.emitirPin(pinConsentido.id, { identidadVerificada: true, consentimiento: true, consentimientoVersion, consentimientoHuella });
  assert.ok(await prisma.consent.count({ where: { memberId: pinConsentido.id, origen: 'recepcion_acceso', version: consentimientoVersion } }) === 1, 'PIN de recepcion registra consentimiento expreso versionado');
  await prisma.member.update({ where: { id: pinConsentido.id }, data: { activo: false } });
  await denegado(() => acceso.emitirPin(pinConsentido.id, { identidadVerificada: true }));
  const staffLocal = await prisma.user.create({ data: { email: 'staff-prueba@example.invalid', nombre: 'Staff local', passwordHash: bcrypt.hashSync('clave-ficticia-local', 10), rol: 'recepcion' } });
  const staff = await jwt.signAsync({ sub: staffLocal.id, tipo: 'staff' });
  assert.ok(await guard.canActivate(contexto(staff, 'miQr')), 'Guard conserva autenticacion staff');
  assert.ok(members.resumen(creado, { estado: 'vencida', fechaFin: new Date(Date.now() + 100000000) }).estado === 'vencido', 'Estado vencido ERP prevalece sobre fecha futura');
  grupos++;
  console.log(`Acceso: ${grupos} grupos de integracion completados en SQLite temporal`);
}

main().catch((error) => {
  console.error('Fallo en pruebas de acceso:', error.name, error.message);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
  if (portalUrlPrevia === undefined) delete process.env.PORTAL_URL;
  else process.env.PORTAL_URL = portalUrlPrevia;
  const ruta = resolve(carpeta);
  if (!ruta.startsWith(baseTemporal + sep) || !basename(ruta).startsWith('gym-acceso-test-')) throw new Error('Carpeta de pruebas fuera del directorio temporal');
  rmSync(ruta, { recursive: true, force: true });
});
