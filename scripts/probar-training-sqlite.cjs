/** Compatibilidad local SQLite; base temporal nueva sin leer .env. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forcesgym-training-test-'));
const database = `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}`;
fs.writeFileSync(path.join(dir, 'test.db'), '');
const schema = path.join(dir, 'schema.prisma');
fs.writeFileSync(schema, fs.readFileSync(path.join(repo, 'prisma/schema.prisma'), 'utf8').replace(/(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/, '$1"sqlite"'));
process.env.DATABASE_URL = database;
const { PrismaClient } = require('@prisma/client');
const clients = [new PrismaClient(), new PrismaClient()];
async function main() {
  try {
    assert.equal(clients[0]._engineConfig.activeProvider, 'sqlite', 'Genera el cliente SQLite antes del ensayo');
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schema], { cwd: repo, env: { ...process.env, RUST_LOG: 'debug', RUST_BACKTRACE: '1' }, stdio: 'pipe' });
    require('ts-node/register');
    const result = await require('../test/training-concurrencia.test').probarEntrenamiento(clients);
    console.log(`SQLite local: ${result.pruebas} comprobaciones de entrenamiento aprobadas`);
  } finally {
    await Promise.all(clients.map(c => c.$disconnect()));
    const target = fs.realpathSync(dir);
    assert(target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    assert(path.basename(target).startsWith('forcesgym-training-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
