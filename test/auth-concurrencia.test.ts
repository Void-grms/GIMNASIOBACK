/** Carreras reales con dos clientes de BD; PostgreSQL solo admite localhost de pruebas. */
import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as bcryptAnterior from 'bcryptjs';
import { PrismaService } from '../src/prisma/prisma.service';
import { MembersService } from '../src/members/members.service';
import { SettingsService } from '../src/settings/settings.service';
import { AccesoService } from '../src/members/acceso.service';
import { QrService } from '../src/qr/qr.service';
import { AuthService } from '../src/auth/auth.service';
import { IntentosService } from '../src/auth/intentos.service';
import { JwtGuard } from '../src/auth/jwt.guard';
import { PortalService } from '../src/portal/portal.service';
import { PortalController } from '../src/portal/portal.controller';
import { hashPassword, verifyPassword } from '../src/common/password';

const passwordExports = require('../src/common/password') as typeof import('../src/common/password');
const raizTemporal = realpathSync(tmpdir());
const carpeta = realpathSync(mkdtempSync(join(raizTemporal, 'gym-auth-test-')));
const repo = resolve(__dirname, '..');
const pg = process.env.PG_TEST_DATABASE_URL;
if (pg) {
  const destino = new URL(pg);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(destino.hostname) || !/test|qa|concurrencia/i.test(destino.pathname)) {
    throw new Error('PG_TEST_DATABASE_URL debe apuntar a una base de pruebas en localhost');
  }
  if (!process.env.PG_TEST_CLIENT) throw new Error('Falta PG_TEST_CLIENT generado para PostgreSQL de pruebas');
}
const url = pg || `file:${join(carpeta, 'auth.sqlite').replace(/\\/g, '/')}`;
const Cliente = pg ? require(resolve(process.env.PG_TEST_CLIENT!)).PrismaClient : PrismaService;
const prisma = new Cliente({ datasources: { db: { url } } });
const prismaB = new Cliente({ datasources: { db: { url } } });
const settings = new SettingsService(prisma);
const members = new MembersService(prisma, new QrService(), settings);
const acceso = new AccesoService(prisma, settings);
const jwt = new JwtService({ secret: 'secreto-ficticio-local-concurrencia', signOptions: { expiresIn: '1h' } });
const auth = new AuthService(prisma, jwt, new IntentosService(prisma));
const authB = new AuthService(prismaB, jwt, new IntentosService(prismaB));
const portal = new PortalService(prisma, members, new QrService(), jwt, new IntentosService(prisma));
const portalB = new PortalService(prismaB, new MembersService(prismaB, new QrService(), new SettingsService(prismaB)), new QrService(), jwt, new IntentosService(prismaB));
const guard = new JwtGuard(jwt, new Reflector(), prisma);
const identificadores: string[] = [];
const staffIds: string[] = [];
const memberIds: string[] = [];
const etiqueta = randomUUID();
let etapa = 'preparacion';

function preparar() {
  if (pg) return;
  const schema = join(repo, 'prisma', 'schema.prisma');
  assert.ok(/provider\s*=\s*"sqlite"/.test(readFileSync(schema, 'utf8')));
  const args = [join(repo, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--schema', schema, '--skip-generate'];
  try { execFileSync(process.execPath, args, { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }); }
  catch { execFileSync(process.execPath, args, { env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'debug' }, stdio: 'pipe' }); }
}

function contexto(token: string): ExecutionContext {
  return { getHandler: () => PortalController.prototype.miQr, getClass: () => PortalController, switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }) } as unknown as ExecutionContext;
}

async function rechazado(trabajo: Promise<unknown> | (() => Promise<unknown>), status = 401) {
  const ejecutar = typeof trabajo === 'function' ? trabajo : () => trabajo;
  await assert.rejects(ejecutar, (e: any) => e instanceof HttpException && e.getStatus() === status);
}

function barreraVerificacion(texto: string) {
  const original = passwordExports.verifyPassword;
  let soltar!: () => void;
  let avisar!: () => void;
  const esperando = new Promise<void>((resolve) => { avisar = resolve; });
  const libre = new Promise<void>((resolve) => { soltar = resolve; });
  passwordExports.verifyPassword = async (valor, hash) => {
    const resultado = await original(valor, hash);
    if (valor === texto) { avisar(); await libre; }
    return resultado;
  };
  return { esperando, soltar: () => { passwordExports.verifyPassword = original; soltar(); } };
}

async function main() {
  preparar();
  await Promise.all([prisma.$connect(), prismaB.$connect()]);
  const hashAnterior = bcryptAnterior.hashSync('clave-anterior-ficticia', 10);
  etapa = 'compatibilidad y event loop';
  assert.ok(await verifyPassword('clave-anterior-ficticia', hashAnterior), 'bcrypt nativo acepta hashes bcryptjs');
  const hashNativo = await hashPassword('clave-nativa-ficticia');
  assert.ok(bcryptAnterior.compareSync('clave-nativa-ficticia', hashNativo), 'Hashes nuevos conservan compatibilidad');
  let ticks = 0;
  let demoraMaxima = 0;
  let ultimo = performance.now();
  const reloj = setInterval(() => { const ahora = performance.now(); demoraMaxima = Math.max(demoraMaxima, ahora - ultimo); ultimo = ahora; ticks++; }, 10);
  const inicio = performance.now();
  const lote = await Promise.all(Array.from({ length: 200 }, () => verifyPassword('clave-anterior-ficticia', hashAnterior)));
  clearInterval(reloj);
  assert.ok(lote.every(Boolean) && ticks > 5 && demoraMaxima < 1000, '200 verificaciones conservan actividad del event loop');
  console.log(`bcrypt async: 200 verificaciones, ${Math.round(performance.now() - inicio)} ms, ${ticks} ticks, pausa maxima ${Math.round(demoraMaxima)} ms`);

  const user = await prisma.user.create({ data: { email: `concurrencia-${etiqueta}@example.invalid`, nombre: 'Prueba concurrencia', passwordHash: hashAnterior, rol: 'admin' } });
  staffIds.push(user.id); identificadores.push(user.email);
  const socio = await prisma.member.create({ data: { dni: String(62000000 + Math.floor(Math.random() * 100000) * 10), nombres: 'Prueba', apellidos: `Concurrencia ${etiqueta}`, pinHash: await hashPassword('8642'), pinCambiado: true, codigoERP: `prueba-${etiqueta}` } });
  memberIds.push(socio.id); identificadores.push(socio.dni);

  etapa = 'cinco fallos staff concurrentes entre dos clientes';
  const fallos = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => (i % 2 ? authB : auth).loginStaff(user.email, 'incorrecta-ficticia', '127.0.0.1')));
  assert.ok(fallos.every((r) => r.status === 'rejected'), 'Ningun fallo autentica');
  let estado = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(estado.bloqueadoHasta?.getTime() > Date.now() && estado.intentosFallidos === 0, 'Cinco fallos bloquean sin perder incrementos');
  assert.ok(await prisma.loginAttempt.count({ where: { identificador: user.email, exito: false } }) === 5, 'Cada intento deja auditoria');

  etapa = 'cinco fallos socio concurrentes entre dos clientes';
  const fallosSocio = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => (i % 2 ? portalB : portal).login(socio.dni, '9998', '127.0.0.1')));
  assert.ok(fallosSocio.every((r) => r.status === 'rejected'));
  let estadoSocio = await prisma.member.findUniqueOrThrow({ where: { id: socio.id } });
  assert.ok(estadoSocio.bloqueadoHasta?.getTime() > Date.now() && estadoSocio.intentosFallidos === 0, 'Cinco fallos socio bloquean entre replicas');

  etapa = 'login viejo despues de cambio de clave';
  await prisma.user.update({ where: { id: user.id }, data: { bloqueadoHasta: null, intentosFallidos: 0 } });
  const retenido = barreraVerificacion('clave-anterior-ficticia');
  const loginViejo = auth.loginStaff(user.email, 'clave-anterior-ficticia');
  try {
    await retenido.esperando;
    await prismaB.user.update({ where: { id: user.id }, data: { passwordHash: hashNativo, sessionVersion: { increment: 1 }, intentosFallidos: 3 } });
  } finally { retenido.soltar(); }
  await rechazado(loginViejo);
  estado = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(estado.intentosFallidos === 3 && estado.sessionVersion === 1, 'Verificacion vieja no limpia el estado de otra credencial');
  const sesion = await auth.loginStaff(user.email, 'clave-nativa-ficticia');
  assert.ok(jwt.decode(sesion.access_token).sessionVersion === 1);

  etapa = 'un login correcto pendiente no elimina bloqueo nuevo';
  const antesBloqueo = barreraVerificacion('clave-nativa-ficticia');
  const correctoPendiente = auth.loginStaff(user.email, 'clave-nativa-ficticia');
  try {
    await antesBloqueo.esperando;
    await Promise.allSettled(Array.from({ length: 5 }, (_, i) => (i % 2 ? authB : auth).loginStaff(user.email, 'incorrecta-ficticia')));
  } finally { antesBloqueo.soltar(); }
  await rechazado(correctoPendiente);
  estado = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(estado.bloqueadoHasta?.getTime() > Date.now(), 'Login lento no desbloquea una cuenta bloqueada entre tanto');

  etapa = 'cambios simultaneos de clave y sesiones staff';
  await prisma.user.update({ where: { id: user.id }, data: { bloqueadoHasta: null, intentosFallidos: 0 } });
  const cambios = await Promise.allSettled([
    auth.cambiarClave(user.id, 'clave-nativa-ficticia', 'clave-destino-uno', 1),
    authB.cambiarClave(user.id, 'clave-nativa-ficticia', 'clave-destino-dos', 1),
  ]);
  assert.ok(cambios.filter((r) => r.status === 'fulfilled').length === 1, 'Solo una actualizacion de la misma credencial puede ganar');
  estado = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(estado.sessionVersion === 2);
  await rechazado(() => guard.canActivate(contexto(sesion.access_token)));
  const ganador = cambios.find((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')!;
  assert.ok(await guard.canActivate(contexto(ganador.value.access_token)), 'Cambio conserva sesion propia con token nuevo');
  await prisma.user.update({ where: { id: user.id }, data: { activo: false } });
  await rechazado(() => guard.canActivate(contexto(ganador.value.access_token)));

  etapa = 'cambios simultaneos de PIN';
  await prisma.member.update({ where: { id: socio.id }, data: { bloqueadoHasta: null, intentosFallidos: 0 } });
  const antesPin = await portal.login(socio.dni, '8642');
  const cambiosPin = await Promise.allSettled([
    portal.actualizarPerfil(socio.id, { pinActual: '8642', pinNuevo: '5826' }, 0),
    portalB.actualizarPerfil(socio.id, { pinActual: '8642', pinNuevo: '9753' }, 0),
  ]);
  assert.ok(cambiosPin.filter((r) => r.status === 'fulfilled').length === 1);
  estadoSocio = await prisma.member.findUniqueOrThrow({ where: { id: socio.id } });
  assert.ok(estadoSocio.portalVersion === 1);
  await rechazado(() => guard.canActivate(contexto(antesPin.access_token)));
  const pinGanador = cambiosPin.find((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')!;
  assert.ok(await guard.canActivate(contexto(pinGanador.value.access_token)));

  etapa = 'login de PIN viejo pendiente frente a restablecimiento';
  await prisma.consent.create({ data: { memberId: socio.id, tipo: 'datos_personales', version: 'test', texto: 'Aceptacion ficticia de prueba', aceptado: true } });
  const pinActual = await verifyPassword('5826', estadoSocio.pinHash) ? '5826' : '9753';
  const loginPinRetenido = barreraVerificacion(pinActual);
  const conPinAnterior = portal.login(socio.dni, pinActual);
  let restablecido: Awaited<ReturnType<AccesoService['emitirPin']>>;
  try {
    await loginPinRetenido.esperando;
    restablecido = await acceso.emitirPin(socio.id, { identidadVerificada: true });
  } finally { loginPinRetenido.soltar(); }
  await rechazado(conPinAnterior);
  estadoSocio = await prisma.member.findUniqueOrThrow({ where: { id: socio.id } });
  assert.ok(estadoSocio.portalVersion === 2 && !estadoSocio.pinCambiado && await verifyPassword(restablecido!.pinInicial, estadoSocio.pinHash), 'Reset invalida resultado de PIN previo');

  etapa = 'expiracion durante verificacion async';
  const expira = barreraVerificacion(restablecido!.pinInicial);
  const loginExpirado = portal.login(socio.dni, restablecido!.pinInicial);
  try {
    await expira.esperando;
    await prismaB.member.update({ where: { id: socio.id }, data: { pinTemporalHasta: new Date(Date.now() - 1000), intentosFallidos: 2 } });
  } finally { expira.soltar(); }
  await rechazado(loginExpirado);
  estadoSocio = await prisma.member.findUniqueOrThrow({ where: { id: socio.id } });
  assert.ok(estadoSocio.intentosFallidos === 2 && estadoSocio.portalVersion === 2, 'PIN vencido mientras bcrypt trabaja no autentica ni limpia contador');
  assert.throws(() => hashPassword('á'.repeat(40)), /72 bytes/, 'Nueva clave UTF-8 no puede truncarse silenciosamente');
  console.log(`Auth concurrencia: compatibilidad, carga bcrypt200 y 8 carreras verificadas con dos clientes ${pg ? 'PostgreSQL local' : 'SQLite temporal'}`);
}

main().catch((e) => { console.error(`Fallo auth concurrencia (${etapa}):`, e.name, e.message); process.exitCode = 1; }).finally(async () => {
  if (pg) {
    await prisma.loginAttempt.deleteMany({ where: { identificador: { in: identificadores } } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.user.deleteMany({ where: { id: { in: staffIds } } });
  }
  await Promise.all([prisma.$disconnect(), prismaB.$disconnect()]);
  const ruta = resolve(carpeta);
  if (!ruta.startsWith(raizTemporal + sep) || !basename(ruta).startsWith('gym-auth-test-')) throw new Error('Directorio temporal inesperado');
  rmSync(ruta, { recursive: true, force: true });
});
