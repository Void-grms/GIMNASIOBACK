/** Carga reproducible SOLO en PostgreSQL local, con dos instancias y datos ficticios.
 * Requiere PostgreSQL de pruebas y npm run build. No utiliza la URL de produccion.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const repo = path.resolve(__dirname, '..');
const url = new URL(process.env.LOAD_DATABASE_URL || 'postgresql://postgres:forcesgym-local-tests@127.0.0.1:55438/forcesgym_test');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Solo admite una base local de pruebas');
assert.ok(url.pathname.startsWith('/forcesgym_test'), 'La base debe llamarse forcesgym_test...');
const schema = `carga_${Date.now()}`;
url.searchParams.set('schema', schema);
url.searchParams.set('connection_limit', '8');
url.searchParams.set('pool_timeout', '10');
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'secreto-ficticio-exclusivo-pruebas-carga';
process.env.QR_SECRET = 'qr-ficticio-exclusivo-pruebas-carga';
process.env.PORTAL_URL = 'http://localhost:3000/portal';
delete process.env.TRUST_PROXY;
fs.mkdirSync(path.join(repo, 'reports'), { recursive: true });
const schemaPath = path.join(repo, 'reports', 'schema-carga.prisma');
const clientPath = path.join(repo, 'reports', 'carga-client');
fs.writeFileSync(schemaPath, fs.readFileSync(path.join(repo, 'prisma', 'schema.prisma'), 'utf8')
  .replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"')
  .replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output = "./carga-client"'));
for (const args of [['generate'], ['db', 'push', '--skip-generate']]) {
  execFileSync(process.execPath, [path.join(repo, 'node_modules/prisma/build/index.js'), ...args, '--schema', schemaPath], { cwd: repo, env: process.env, stdio: 'pipe' });
}
// El cliente PostgreSQL de esta prueba no reemplaza el cliente SQLite local.
const client = require(clientPath);
require.cache[require.resolve('@prisma/client')] = { exports: client };
require('reflect-metadata');
const { LoginRateService } = require('../dist/src/common/login-rate.service');
const bcrypt = require('bcrypt');
const servidores = [];
let db;
let db2;

function iniciarServidor() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'servidor-carga.cjs')], {
      cwd: repo, windowsHide: true, env: { ...process.env, LOAD_PRISMA_CLIENT: clientPath },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    servidores.push(child);
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => reject(new Error('El servidor local no arranco a tiempo')), 15000);
    child.once('message', msg => { clearTimeout(timeout); resolve(msg.endpoint); });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error(output || `Servidor local fallo: ${code}`)); });
  });
}

function resumen(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const p = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
  return { solicitudes: times.length, p50ms: p(.5), p95ms: p(.95), maxMs: Math.round(sorted.at(-1)) };
}

async function main() {
  db = new client.PrismaClient();
  db2 = new client.PrismaClient();
  const rates = [new LoginRateService(db), new LoginRateService(db2)];
  const endpoints = await Promise.all([iniciarServidor(), iniciarServidor()]);
  await db.settings.create({ data: { id: 'default', consentimientoTexto: 'Consentimiento ficticio de la prueba local.' } });
  const hash = await bcrypt.hash('7038', 10);
  await db.member.createMany({ data: Array.from({ length: 2200 }, (_, i) => ({
    id: `load-${i}`, dni: String(81000000 + i), codigoERP: String(90000 + i), nombres: 'Socio ficticio', apellidos: String(i),
    pinHash: hash, pinCambiado: true,
  })) });
  await db.credential.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ memberId: `load-${i}`, secret: randomBytes(32).toString('hex') })) });
  const plan = await db.plan.create({ data: { nombre: 'Plan ficticio de carga', precio: 90, duracionDias: 30 } });
  const ahora = Date.now();
  await db.membership.createMany({ data: Array.from({ length: 7040 }, (_, i) => ({
    memberId: `load-${i % 2200}`, planId: plan.id, precioPagado: 90,
    fechaInicio: new Date(ahora - (i < 2200 ? 10 : 60) * 86400000),
    fechaFin: new Date(ahora + (i < 2200 ? 20 : -30) * 86400000),
    estado: i < 2200 ? 'activa' : 'vencida',
  })) });
  await db.checkIn.createMany({ data: Array.from({ length: 6000 }, (_, i) => ({
    memberId: `load-${i % 200}`, tipo: Math.floor(i / 200) % 2 ? 'salida' : 'entrada',
    timestamp: new Date(ahora - (6000 - i) * 60000), metodo: 'manual', resultado: 'permitido',
  })) });
  await db.payment.createMany({ data: Array.from({ length: 2000 }, (_, i) => ({
    memberId: `load-${i % 200}`, concepto: 'membresia', monto: 90, metodo: 'efectivo', fecha: new Date(ahora - i * 60000),
  })) });
  const loginTimes = [];
  const start = performance.now();
  const tokens = await Promise.all(Array.from({ length: 200 }, async (_, i) => {
    const started = performance.now();
    const r = await fetch(`${endpoints[i % 2]}/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dni: String(81000000 + i), pin: '7038' }), signal: AbortSignal.timeout(30000) });
    const body = await r.json();
    assert.equal(r.status, 201, `Login ficticio ${i}: ${JSON.stringify(body)}`);
    loginTimes.push(performance.now() - started);
    return body.access_token;
  }));
  const login = { ...resumen(loginTimes), duracionMs: Math.round(performance.now() - start) };

  const readTimes = [];
  const readStart = performance.now();
  // 200 personas simultaneas; cada una realiza 15 consultas reales del portal.
  await Promise.all(tokens.map(async (token, i) => {
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      await Promise.all(['me', 'qr', 'presence'].map(async route => {
        const began = performance.now();
        const response = await fetch(`${endpoints[(i + vuelta) % 2]}/portal/${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
        assert.equal(response.status, 200, `Lectura ${route} socio ${i}`);
        await response.json();
        readTimes.push(performance.now() - began);
      }));
    }
  }));
  const lecturas = { ...resumen(readTimes), duracionMs: Math.round(performance.now() - readStart) };

  const limite = await Promise.all(Array.from({ length: 30 }, (_, i) => rates[i % 2].tomar('prueba-compartida-atomica', 5, 60000)));
  assert.equal(limite.filter(x => x.permitido).length, 5, 'Dos instancias comparten un solo cupo atomico');
  const throttle = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const r = await fetch(`${endpoints[i % 2]}/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dni: '81000200', pin: '9999' }) });
    await r.json();
    return r.status;
  }));
  assert.equal(throttle.filter(x => x === 401).length, 5);
  assert.equal(throttle.filter(x => x === 429).length, 15);
  const bloqueado = await db.member.findUnique({ where: { id: 'load-200' } });
  assert.ok(bloqueado.bloqueadoHasta > new Date(), 'Cinco fallos concurrentes bloquean la cuenta');
  assert.equal(await db.member.count(), 2200);
  assert.equal(await db.checkIn.count(), 6000, 'Las consultas no crean asistencias');
  const resultado = { fecha: new Date().toISOString(), entorno: 'LOCAL PostgreSQL 18, dos procesos Nest independientes; 200 socios simultaneos, misma IP; 2200 socios/7040 contratos/6000 asistencias/2000 pagos ficticios', login, lecturas, errores: 0, limiteCompartido: '5 de 30', fuerzaBruta: '5 denegados + 15 limitados; cuenta bloqueada', limitacion: 'No mide latencia de Internet ni recursos de Railway. No es garantia de capacidad en produccion.' };
  fs.writeFileSync(path.join(repo, 'reports', 'carga-200.json'), JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado, null, 2));
}

main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => {
  await Promise.all(servidores.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.send('cerrar');
  })));
  if (db) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([db?.$disconnect(), db2?.$disconnect()]);
});
