/** PostgreSQL local desechable. Nunca acepta una URL externa ni credenciales del gimnasio. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..'), reports = path.join(repo, 'reports');
fs.mkdirSync(reports, { recursive: true });
const database = `forcesgym_test_training_${Date.now()}`;
const url = `postgresql://postgres:forcesgym-local-tests@127.0.0.1:55438/${database}?connection_limit=8&pool_timeout=30`;
assert.equal(new URL(url).hostname, '127.0.0.1');
assert.match(database, /^forcesgym_test_training_\d+$/);
Object.assign(process.env, { DATABASE_URL: url, NODE_ENV: 'test', JWT_SECRET: 'training-local-sin-datos-reales', QR_SECRET: 'qr-local-entrenamiento' });
const docker = args => execFileSync('docker', ['exec', 'forcesgym-concurrency-20261015', ...args], { stdio: 'pipe' });
const prisma = args => execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], { cwd: repo, env: process.env, stdio: 'pipe' });
const schema = (text, output) => text.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"').replace('provider = "prisma-client-js"', `provider = "prisma-client-js"\n output = "./${output}"`);
const oldPath = path.join(reports, 'training-old.prisma'), newPath = path.join(reports, 'training-new.prisma');
// Último esquema anterior a las sesiones: sigue siendo la referencia al repetir
// el ensayo después de integrar este cambio en main.
fs.writeFileSync(oldPath, schema(execFileSync('git', ['show', 'ca1f74f:prisma/schema.prisma'], { cwd: repo }).toString(), 'training-old-client'));
fs.writeFileSync(newPath, schema(fs.readFileSync(path.join(repo, 'prisma/schema.prisma'), 'utf8'), 'training-client'));
let db, db2, oldDb, server;
const report = { alcance: 'API y PostgreSQL locales con datos ficticios; no acredita recursos ni latencia de Railway.', pruebas: 0, cargas: [] };
async function iniciarApi() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(repo, 'scripts/servidor-carga.cjs')], {
      cwd: repo, env: { ...process.env, LOAD_PRISMA_CLIENT: path.join(reports, 'training-client') }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let out = ''; server.stderr.on('data', d => out += d);
    const timeout = setTimeout(() => reject(Error(`API no inicia: ${out}`)), 25000);
    server.once('message', m => { clearTimeout(timeout); resolve(m.endpoint); });
    server.once('error', reject);
    server.once('exit', c => { if (c) reject(Error(out)); });
  });
}
async function carga(endpoint, count) {
  const { JwtService } = require('@nestjs/jwt');
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const prefix = `load-training-${count}-${randomUUID()}`;
  const exerciseId = `${prefix}-exercise`;
  const miembros = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, dni: String(87000000 + count * 100 + i), nombres: 'FICTICIO', apellidos: 'CARGA ENTRENAMIENTO', pinHash: 'sin-acceso', pinCambiado: true, portalVersion: 0 }));
  await db.member.createMany({ data: miembros });
  await db.exercise.create({ data: { id: exerciseId, nombre: 'EJERCICIO DE CARGA', grupo: 'pecho' } });
  const latencias = [], errores = [];
  async function request(token, resource, body, method = body ? 'POST' : 'GET', expected) {
    const start = performance.now();
    const res = await fetch(`${endpoint}/portal/${resource}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json(); latencias.push(performance.now() - start);
    if (expected) assert.equal(res.status, expected, JSON.stringify(json));
    else assert(res.ok, JSON.stringify({ status: res.status, json }));
    return json;
  }
  const inicio = performance.now();
  await Promise.all(miembros.map(async (m, i) => {
    const token = jwt.sign({ sub: m.id, tipo: 'socio', portalVersion: 0 }, { expiresIn: '15m' });
    try {
      const s = await request(token, 'workout-sessions', { operationId: randomUUID(), titulo: 'Carga de prueba' });
      const body = { exerciseId, sessionId: s.id, operationId: randomUUID(), series: [{ repeticiones: 8 + i % 5, pesoKg: 20 + i % 10 }] };
      const [uno, dos] = await Promise.all([request(token, 'workouts', body), request(token, 'workouts', body)]);
      assert.equal(uno.sets[0].id, dos.sets[0].id);
      const own = await request(token, 'workout-sessions/active');
      assert.equal(own.id, s.id); assert.equal(own.series.length, 1); assert.equal(own.series[0].id, uno.sets[0].id);
      await request(token, `progress/${exerciseId}?semanas=8`);
      await request(token, `workout-sessions/${s.id}/finish`, {});
    } catch (e) { errores.push({ socioFicticio: i, error: e.message }); }
  }));
  const tiempoMs = performance.now() - inicio;
  assert.deepEqual(errores, [], JSON.stringify(errores.slice(0, 8)));
  const rows = await db.workoutSet.findMany({ where: { memberId: { in: miembros.map(m => m.id) } } });
  assert.equal(rows.length, count);
  assert.equal(new Set(rows.map(r => r.memberId)).size, count);
  assert.equal(await db.workoutSession.count({ where: { memberId: { in: miembros.map(m => m.id) }, endedAt: null } }), 0);
  const tokenA = jwt.sign({ sub: miembros[0].id, tipo: 'socio', portalVersion: 0 });
  const ajena = rows.find(r => r.memberId === miembros[1].id);
  await request(tokenA, `workouts/${ajena.id}`, { pesoKg: 45 }, 'PATCH', 403);
  await request(tokenA, `workouts/${ajena.id}`, undefined, 'DELETE', 403);
  await request(tokenA, `workout-sessions/${ajena.sessionId}`, undefined, 'GET', 403);
  await request(tokenA, 'workouts', { exerciseId, operationId: randomUUID(), memberId: miembros[1].id, series: [{ repeticiones: 5, pesoKg: 10 }] }, 'POST', 400);
  const sorted = latencias.sort((a, b) => a - b);
  const result = { usuariosSimultaneos: count, solicitudes: latencias.length, tiempoMs: Math.round(tiempoMs), p50ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]), p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]), errores: errores.length, seriesFinales: rows.length, duplicados: rows.length - count, crucesDeCuenta: 0 };
  console.log(`ok carga API local: ${JSON.stringify(result)}`);
  return result;
}
async function main() {
  docker(['createdb', '-U', 'postgres', database]);
  try {
    prisma(['generate', '--schema', oldPath]); prisma(['db', 'push', '--skip-generate', '--schema', oldPath]);
    oldDb = new (require(path.join(reports, 'training-old-client')).PrismaClient)();
    const member = await oldDb.member.create({ data: { id: 'training-historico-qa', nombres: 'HISTORICO', apellidos: 'FICTICIO', pinHash: 'sin-acceso' } });
    const exercise = await oldDb.exercise.create({ data: { nombre: 'CARDIO HISTORICO', grupo: 'cardio' } });
    const set = await oldDb.workoutSet.create({ data: { memberId: member.id, exerciseId: exercise.id, fecha: new Date('2026-09-10T00:00:00Z'), repeticiones: 20, pesoKg: 8 } });
    await oldDb.$disconnect(); oldDb = null;
    prisma(['generate', '--schema', newPath]); prisma(['db', 'push', '--skip-generate', '--schema', newPath]);
    const Client = require(path.join(reports, 'training-client'));
    db = new Client.PrismaClient(); db2 = new Client.PrismaClient();
    assert.deepEqual(await db.member.findUnique({ where: { id: member.id } }), member);
    const after = await db.workoutSet.findUnique({ where: { id: set.id } });
    for (const [key, value] of Object.entries(set)) assert.deepEqual(after[key], value);
    assert.equal(after.tipo, null); assert.equal(after.sessionId, null); assert.equal(after.duracionMinutos, null);
    assert.equal(await db.workoutSession.count(), 0);
    prisma(['db', 'push', '--skip-generate', '--schema', newPath]);
    console.log('ok migracion aditiva repetible conserva socios y series historicas sin sesiones inventadas');
    require.cache[require.resolve('@prisma/client')] = { exports: Client };
    require('ts-node/register');
    report.pruebas = (await require('../test/training-concurrencia.test').probarEntrenamiento([db, db2])).pruebas;
    const endpoint = await iniciarApi();
    for (const count of [50, 200]) report.cargas.push(await carga(endpoint, count));
    fs.writeFileSync(path.join(reports, 'training-verificacion.json'), JSON.stringify(report, null, 2));
  } finally {
    if (server?.connected) server.send('cerrar');
    if (server) await new Promise(resolve => { server.once('exit', resolve); setTimeout(() => { server.kill(); resolve(); }, 5000).unref(); });
    await Promise.all([oldDb?.$disconnect(), db?.$disconnect(), db2?.$disconnect()]);
    assert.match(database, /^forcesgym_test_training_\d+$/);
    docker(['dropdb', '-U', 'postgres', '--if-exists', database]);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
