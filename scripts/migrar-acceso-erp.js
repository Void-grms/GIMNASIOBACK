/** Migra PostgreSQL de forma explícita antes de verificar el esquema con db push. */
const fs = require('fs');
const path = require('path');

async function migrar(prisma, databaseUrl) {
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl || '')) {
    console.log('[migracion-erp] SQLite se actualiza mediante db push.');
    return;
  }
  const schema = new URL(databaseUrl).searchParams.get('schema') || 'public';
  if (schema !== 'public') throw new Error('La migracion ERP requiere el esquema public');
  const statements = ['erp-access.sql', 'membership-plans.sql', 'sunat-beta.sql'].flatMap(nombre =>
    fs.readFileSync(path.join(__dirname, '..', 'prisma', nombre), 'utf8').split(/^-- statement-break\s*$/m).map(s => s.trim()).filter(s => s && !/^--[^\n]*$/.test(s)));
  const aplicado = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(20261014, 1)::text AS locked');
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '15s'");
    const [base] = await tx.$queryRawUnsafe(`SELECT
      to_regclass('public."Member"') IS NOT NULL AS "memberExists",
      to_regclass('public."Membership"') IS NOT NULL AS "membershipExists"`);
    if (!base.memberExists && !base.membershipExists) return false;
    if (!base.memberExists || !base.membershipExists) throw new Error('La base tiene un esquema parcial');
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    return true;
  }, { maxWait: 30000, timeout: 60000 });
  console.log(aplicado ? '[migracion-erp] Esquema ERP actualizado sin eliminar datos.' : '[migracion-erp] Base nueva: db push creara el esquema completo.');
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!url) throw new Error('Falta DATABASE_URL');
  if (!/^postgres(ql)?:\/\//i.test(url)) return migrar(null, url);
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try { await migrar(prisma, url); } finally { await prisma.$disconnect(); }
}

module.exports = { migrar };
if (require.main === module) main().catch(() => {
  console.error('[migracion-erp] No se pudo actualizar el esquema; la transaccion se revirtio. Revisar esquema, permisos y restricciones.');
  process.exitCode = 1;
});
