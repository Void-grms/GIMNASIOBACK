/**
 * Prisma no deja leer el provider de una variable de entorno, asi que este
 * script lo ajusta segun DATABASE_URL antes de generar el cliente:
 *
 *   file:./gimnasio.db        -> sqlite      (la PC de recepcion, desarrollo)
 *   postgresql://... | postgres://...  -> postgresql  (Railway u otro servidor)
 *
 * Se corre en el build y antes de `prisma db push`. Es idempotente.
 */
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL || '';
const proveedor = /^postgres(ql)?:\/\//i.test(url) ? 'postgresql' : 'sqlite';

const archivo = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const actual = fs.readFileSync(archivo, 'utf8');
const nuevo = actual.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/,
  `$1"${proveedor}"`,
);

if (nuevo !== actual) fs.writeFileSync(archivo, nuevo);
console.log(`[elegir-base] Prisma usara ${proveedor}`);
