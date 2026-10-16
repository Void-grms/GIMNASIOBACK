/** Requiere PostgreSQL local: puerto 55438, usuario postgres y clave de pruebas. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..'),
  reports = path.join(repo, 'reports');
fs.mkdirSync(reports, { recursive: true });
const database = `forcesgym_test_sunat_${Date.now()}`;
const url = `postgresql://postgres:forcesgym-local-tests@127.0.0.1:55438/${database}`;
assert.equal(new URL(url).hostname, '127.0.0.1');
assert.match(database, /^forcesgym_test_sunat_\d+$/);
Object.assign(process.env, {
  DATABASE_URL: url,
  NODE_ENV: 'test',
  JWT_SECRET: 'sunat-pruebas-locales-sin-valor',
  QR_SECRET: 'qr-solo-prueba',
});
const docker = (args) =>
  execFileSync('docker', ['exec', 'forcesgym-concurrency-20261015', ...args], {
    stdio: 'pipe',
  });
const prisma = (args) =>
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), ...args],
    { cwd: repo, env: process.env, stdio: 'pipe' },
  );
const schema = (text, output) =>
  text
    .replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"')
    .replace(
      'provider = "prisma-client-js"',
      `provider = "prisma-client-js"\n output = "./${output}"`,
    );
const antiguo = path.join(reports, 'sunat-old.prisma'),
  actual = path.join(reports, 'sunat-new.prisma');
fs.writeFileSync(
  antiguo,
  schema(
    execFileSync('git', ['show', '93eb874:prisma/schema.prisma'], {
      cwd: repo,
    }).toString(),
    'sunat-old-client',
  ),
);
fs.writeFileSync(
  actual,
  schema(
    fs.readFileSync(path.join(repo, 'prisma/schema.prisma'), 'utf8'),
    'sunat-client',
  ),
);
const workers = [];
let oldDb, db, db2;
function servidor() {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [path.join(repo, 'scripts/servidor-carga.cjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          LOAD_PRISMA_CLIENT: path.join(reports, 'sunat-client'),
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    workers.push(p);
    let out = '';
    p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => reject(Error('No inicia API local')), 20000);
    p.once('message', (m) => {
      clearTimeout(timer);
      resolve(m.endpoint);
    });
    p.once('error', reject);
    p.once('exit', (c) => {
      if (c) reject(Error(out));
    });
  });
}
async function main() {
  docker(['createdb', '-U', 'postgres', database]);
  try {
    prisma(['generate', '--schema', antiguo]);
    prisma(['db', 'push', '--skip-generate', '--schema', antiguo]);
    oldDb = new (require(
      path.join(reports, 'sunat-old-client'),
    ).PrismaClient)();
    const p = await oldDb.plan.create({
      data: {
        id: 'historico-sunat-qa',
        nombre: 'PLAN HISTORICO FICTICIO',
        precio: 60,
        duracionDias: 30,
        activo: false,
      },
    });
    const miembro = await oldDb.member.create({
      data: {
        id: 'miembro-historico-qa',
        nombres: 'FICTICIO',
        apellidos: 'SIN DATOS REALES',
        pinHash: 'sin-acceso',
      },
    });
    await oldDb.$disconnect();
    oldDb = null;
    prisma(['generate', '--schema', actual]);
    const Client = require(path.join(reports, 'sunat-client'));
    db = new Client.PrismaClient();
    db2 = new Client.PrismaClient();
    const { migrar } = require('./migrar-acceso-erp');
    await migrar(db, url);
    await migrar(db, url);
    assert.deepEqual(await db.plan.findUnique({ where: { id: p.id } }), p);
    assert.deepEqual(
      await db.member.findUnique({ where: { id: miembro.id } }),
      miembro,
    );
    prisma([
      'migrate',
      'diff',
      '--from-url',
      url,
      '--to-schema-datamodel',
      actual,
      '--exit-code',
    ]);
    console.log(
      'ok migracion aditiva repetible conserva filas previas; esquema final sin diferencias',
    );
    require.cache[require.resolve('@prisma/client')] = { exports: Client };
    require('ts-node/register');
    const test = require('../test/sunat.test');
    await test.probarFormatoSunat();
    await test.probarSunat([db, db2]);
    const endpoint = await servidor();
    const { JwtService } = require('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET });
    for (const rol of ['admin', 'recepcion'])
      await db.user.create({
        data: {
          id: `qa-${rol}`,
          email: `${rol}@prueba.invalid`,
          nombre: rol,
          rol,
          passwordHash: 'sin-acceso',
        },
      });
    await db.member.update({
      where: { id: miembro.id },
      data: { dni: '99999999', pinCambiado: true },
    });
    const token = (rol) =>
      rol === 'socio'
        ? jwt.sign({ sub: miembro.id, tipo: 'socio', portalVersion: 0 })
        : jwt.sign({ sub: `qa-${rol}`, tipo: 'staff', rol, sessionVersion: 0 });
    const request = async (route, rol, method = 'GET', body) => {
      const r = await fetch(endpoint + route, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(rol ? { Authorization: 'Bearer ' + token(rol) } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json() };
    };
    const id = (await db.sunatPrueba.findFirst()).id;
    for (const route of [
      '/sunat/config',
      '/sunat/pruebas',
      `/sunat/pruebas/${id}`,
      `/sunat/pruebas/${id}/artefactos/xml`,
      '/settings/admin',
    ]) {
      assert.equal((await request(route, null)).status, 401);
      assert.equal((await request(route, 'recepcion')).status, 403);
      assert.equal((await request(route, 'socio')).status, 403);
    }
    assert.equal((await request('/sunat/config', 'admin')).status, 200);
    assert.equal(
      (
        await request('/sunat/config', 'admin', 'PATCH', {
          entorno: 'produccion',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/sunat/pruebas', 'admin', 'POST', {
          tipo: 'boleta',
          idempotencyKey: 'invalido',
        })
      ).status,
      400,
    );
    assert.equal(
      (await request('/sunat/config', 'admin', 'PATCH', { ruc: null })).status,
      400,
    );
    const read = await request('/settings/admin', 'admin');
    assert.equal(read.status, 200);
    assert(!JSON.stringify(read.body).includes('TOKEN_PSE_FICTICIO'));
    console.log(
      'ok permisos HTTP: anonimo401, recepcion/socio403, admin200; modo productivo/campos invalidos400',
    );
    console.log('SUNAT PostgreSQL: todas las verificaciones aprobadas.');
  } finally {
    await Promise.all(
      workers.map(
        (p) =>
          new Promise((resolve) => {
            p.once('exit', resolve);
            p.send('cerrar');
            setTimeout(() => {
              p.kill();
              resolve();
            }, 5000).unref();
          }),
      ),
    );
    await oldDb?.$disconnect();
    await db?.$disconnect();
    await db2?.$disconnect();
    docker(['dropdb', '-U', 'postgres', '--if-exists', database]);
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
