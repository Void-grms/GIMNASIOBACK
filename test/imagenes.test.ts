import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizarFoto, guardarFotoPublica, rutaFotoLocal, eliminarFotos } from '../src/common/imagenes';
import { guardarImagen } from '../src/common/archivos';
import { MembersService } from '../src/members/members.service';
import { ProductsService } from '../src/products/products.service';

const url = (buffer: Buffer, mime = 'png') => `data:image/${mime};base64,${buffer.toString('base64')}`;
const noExiste = async (ruta: string) => assert.rejects(readFile(ruta), (e: any) => e.code === 'ENOENT');

async function main() {
  const carpeta = await mkdtemp(join(tmpdir(), 'forcesgym-imagenes-'));
  process.env.UPLOADS_DIR = join(carpeta, 'uploads');
  process.env.PRIVATE_DIR = join(carpeta, 'privado');
  const png = await sharp({ create: { width: 1500, height: 900, channels: 4, background: { r: 30, g: 100, b: 180, alpha: 0.6 } } }).png().toBuffer();
  const jpeg = await sharp(png).flatten({ background: '#fff' }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const webp = await sharp(png).webp({ lossless: true }).toBuffer();
  for (const [input, mime] of [[png, 'png'], [jpeg, 'jpeg'], [webp, 'webp']] as const) {
    const guardada = await guardarFotoPublica('socios', `fixture-${mime}`, url(input, mime));
    const meta = await sharp(await readFile(guardada.ruta)).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 480); assert.equal(meta.height, 480);
    assert.equal(meta.exif, undefined); assert.equal(meta.orientation, undefined);
    assert(guardada.bytes < 100_000);
  }
  const producto = await normalizarFoto(jpeg, 'productos');
  const orientada = await sharp(producto).metadata();
  assert(orientada.height > orientada.width, 'Se respeta EXIF antes de redimensionar');
  assert(orientada.height <= 1000 && orientada.width <= 1000);
  const transparente = await sharp(await normalizarFoto(png, 'productos')).metadata();
  assert.equal(transparente.hasAlpha, true);

  for (const entrada of [undefined, {}, url(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'png'), url(Buffer.from('not a JPEG'), 'jpeg'), 'data:image/png;base64,AA=', 'data:image/png;base64,%%%%', `data:image/png;base64,${'A'.repeat(3_000_000)}`]) {
    await assert.rejects(guardarFotoPublica('socios', 'invalida', entrada as any), (e: any) => e.getStatus() === 400);
  }
  const enorme = await sharp({ create: { width: 5001, height: 4000, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(normalizarFoto(enorme, 'socios'), (e: any) => e.getStatus() === 400);
  await assert.rejects(guardarFotoPublica('socios', '../fuera', url(png)), (e: any) => e.getStatus() === 400);
  assert.equal(await rutaFotoLocal('socios', 'fixture-png', 'https://otro.invalid/foto.jpg'), null);
  assert.equal(await rutaFotoLocal('socios', 'fixture-png', '/uploads/socios/../../secreto.jpg'), null);

  const socio: any = { id: 'socio-prueba', dni: '00000001', nombres: 'Demo', apellidos: 'Local', activo: true, fotoUrl: null, portalVersion: 1 };
  const prod: any = { id: 'producto-prueba', fotoUrl: null };
  const borrar = { deleteMany: async () => ({ count: 0 }) };
  const prisma: any = {
    member: { findUnique: async () => ({ ...socio }), update: async ({ data }: any) => Object.assign(socio, data) },
    product: { findUnique: async () => ({ ...prod }), update: async ({ data }: any) => Object.assign(prod, data) },
    credential: borrar, bodyLog: borrar, workoutSet: borrar, portalActivation: borrar,
  };
  prisma.$transaction = (f: any) => f(prisma);
  const miembros = new MembersService(prisma, {} as any, {} as any);
  await miembros.guardarFoto(socio.id, url(png));
  const primera = socio.fotoUrl;
  assert(primera.endsWith('.webp'));
  const reemplazo = await sharp({ create: { width: 700, height: 600, channels: 3, background: '#fbd234' } }).png().toBuffer();
  await Promise.all([miembros.guardarFoto(socio.id, url(png)), miembros.guardarFoto(socio.id, url(reemplazo))]);
  assert.notEqual(socio.fotoUrl, primera);
  await noExiste(join(process.env.UPLOADS_DIR, primera.replace('/uploads/', '')));
  assert.equal((await sharp(await readFile(join(process.env.UPLOADS_DIR, socio.fotoUrl.replace('/uploads/', '')))).metadata()).format, 'webp');

  const productos = new ProductsService(prisma, {} as any);
  await productos.guardarFoto(prod.id, url(png));
  assert(prod.fotoUrl.endsWith('.webp'));
  const rutaProducto = join(process.env.UPLOADS_DIR, prod.fotoUrl.replace('/uploads/', ''));
  await productos.quitarFoto(prod.id);
  assert.equal(prod.fotoUrl, null); await noExiste(rutaProducto);

  const privado = join(process.env.PRIVATE_DIR, 'yape');
  assert.equal(guardarImagen(url(jpeg, 'jpeg'), privado, 'voucher-ficticio'), 'jpg');
  assert((await readFile(join(privado, 'voucher-ficticio.jpg'))).equals(jpeg), 'Comprobante conserva bytes y texto originales');
  const manifiestos = join(process.env.PRIVATE_DIR, 'imagenes-webp', 'socios');
  await mkdir(manifiestos, { recursive: true });
  await writeFile(join(manifiestos, socio.id + '.json'), '{}');
  await writeFile(join(process.env.UPLOADS_DIR, 'socios', socio.id + '.jpg'), jpeg);
  await miembros.anonimizar(socio.id, 'Prueba aislada');
  assert.equal(socio.fotoUrl, null);
  assert.equal((await readdir(join(process.env.UPLOADS_DIR, 'socios'))).some(n => n.startsWith(socio.id)), false);
  await noExiste(join(manifiestos, socio.id + '.json'));
  await assert.rejects(miembros.guardarFoto(socio.id, url(png)), (e: any) => e.getStatus() === 400);
  // Reintentar una supresión también limpia variantes que quedaron pendientes.
  await writeFile(join(process.env.UPLOADS_DIR, 'socios', socio.id + '.png'), png);
  await miembros.anonimizar(socio.id, 'Reintento de limpieza');
  await noExiste(join(process.env.UPLOADS_DIR, 'socios', socio.id + '.png'));

  const concurrencia = await Promise.allSettled(Array.from({ length: 20 }, () => normalizarFoto(png, 'socios')));
  assert(concurrencia.some(r => r.status === 'fulfilled'));
  assert(concurrencia.some(r => r.status === 'rejected' && r.reason.getStatus() === 503));
  await eliminarFotos('socios', 'fixture-png');
  console.log(JSON.stringify({ passed: true, grupos: 10, entorno: 'archivos temporales y repositorio de datos simulado, sin producción', pngBytes: png.length, perfilBytes: (await normalizarFoto(png, 'socios')).length }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
