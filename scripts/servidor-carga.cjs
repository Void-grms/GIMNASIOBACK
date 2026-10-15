/** Proceso auxiliar de probar-carga.cjs. Nunca arranca contra produccion. */
const assert = require('node:assert/strict');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.ok(url.pathname.startsWith('/forcesgym_test'));
assert.ok(process.send && process.env.LOAD_PRISMA_CLIENT, 'Debe iniciarlo el runner de carga');
require.cache[require.resolve('@prisma/client')] = { exports: require(process.env.LOAD_PRISMA_CLIENT) };
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/src/app.module');
let app;
async function main() {
  app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  process.send({ endpoint: `${await app.getUrl()}/api` });
}
process.on('message', async message => {
  if (message === 'cerrar') { await app?.close(); process.exit(0); }
});
main().catch(e => { console.error(e.message); process.exit(1); });
