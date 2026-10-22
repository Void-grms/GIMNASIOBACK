import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { lstat, mkdir, readdir, realpath, rename, unlink, writeFile } from 'fs/promises';
import { basename, join, resolve } from 'path';
import sharp from 'sharp';
import { carpetaArchivos, carpetaPrivada } from './archivos';

export type TipoFoto = 'socios' | 'productos';
const MAX_PIXELES = 20_000_000;
const MAX_ARCHIVO = 10 * 1024 * 1024;
const VERSION = 'webp-v1';
sharp.cache({ memory: 16, files: 0, items: 32 });
sharp.concurrency(1);

let activas = 0;
const pendientes: Array<() => void> = [];
const bloqueos = new Map<string, { cola: Promise<void>; esperando: number }>();

function validarId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw new BadRequestException('Identificador de foto invalido');
}

/** Evita que conversión, subida y supresión del mismo perfil se crucen. */
export async function conFotoBloqueada<T>(tipo: TipoFoto, id: string, operacion: () => Promise<T>): Promise<T> {
  validarId(id);
  const clave = `${tipo}/${id}`;
  let bloqueo = bloqueos.get(clave);
  if (!bloqueo) { bloqueo = { cola: Promise.resolve(), esperando: 0 }; bloqueos.set(clave, bloqueo); }
  if (bloqueo.esperando >= 8) throw new ServiceUnavailableException('Hay una foto en proceso. Intenta de nuevo en unos segundos.');
  bloqueo.esperando++;
  const anterior = bloqueo.cola;
  let liberar!: () => void;
  bloqueo.cola = new Promise<void>(res => { liberar = res; });
  await anterior;
  try { return await operacion(); }
  finally {
    bloqueo.esperando--;
    liberar();
    if (!bloqueo.esperando) bloqueos.delete(clave);
  }
}

async function conProcesador<T>(operacion: () => Promise<T>): Promise<T> {
  if (activas >= 2) {
    if (pendientes.length >= 8) throw new ServiceUnavailableException('Estamos procesando otras fotos. Intenta de nuevo en unos segundos.');
    await new Promise<void>(res => pendientes.push(res));
  } else activas++;
  try { return await operacion(); }
  finally {
    const siguiente = pendientes.shift();
    if (siguiente) siguiente(); else activas--;
  }
}

function datosImagen(dataUrl: string, maxBytes: number) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(maxBytes / 3) * 4 + 64) {
    throw new BadRequestException('La foto no es valida o supera el tamaño permitido.');
  }
  const partes = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl.trim());
  if (!partes || partes[1].length % 4) throw new BadRequestException('La imagen no tiene un formato valido');
  const datos = Buffer.from(partes[1], 'base64');
  if (!datos.length || datos.length > maxBytes || datos.toString('base64') !== partes[1]) {
    throw new BadRequestException('La foto no es valida o supera el tamaño permitido.');
  }
  return datos;
}

function formatoPermitido(datos: Buffer) {
  return (datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff)
    || datos.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (datos.toString('ascii', 0, 4) === 'RIFF' && datos.toString('ascii', 8, 12) === 'WEBP');
}

/** Decodifica de verdad, orienta, redimensiona y elimina EXIF/GPS al volver a codificar. */
export async function normalizarFoto(datos: Buffer, tipo: TipoFoto): Promise<Buffer> {
  if (!Buffer.isBuffer(datos) || !datos.length || datos.length > MAX_ARCHIVO || !formatoPermitido(datos)) {
    throw new BadRequestException('Usa una foto JPEG, PNG o WebP valida.');
  }
  return conProcesador(async () => {
    try {
      const imagen = sharp(datos, { limitInputPixels: MAX_PIXELES, failOn: 'warning' });
      const meta = await imagen.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format) || (meta.pages || 1) > 1 || !meta.width || !meta.height) {
        throw new Error('Formato no permitido');
      }
      const lado = tipo === 'socios' ? 480 : 1000;
      return await imagen.rotate()
        .resize({ width: lado, height: lado, fit: tipo === 'socios' ? 'cover' : 'inside', withoutEnlargement: true })
        .webp({ quality: tipo === 'socios' ? 78 : 80, effort: 4, smartSubsample: true })
        .timeout({ seconds: 10 })
        .toBuffer();
    } catch {
      throw new BadRequestException('No se pudo procesar la foto. Usa una imagen valida de hasta 20 megapixeles.');
    }
  });
}

export async function escribirAtomico(ruta: string, contenido: Buffer | string) {
  const temporal = `${ruta}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporal, contenido, { flag: 'wx' });
    await rename(temporal, ruta);
  } finally { await unlink(temporal).catch(() => undefined); }
}

async function guardarWebp(tipo: TipoFoto, id: string, datos: Buffer) {
  validarId(id);
  const digest = createHash('sha256').update(datos).digest('hex').slice(0, 24);
  const nombre = `${id}-${VERSION}-${digest}.webp`;
  const carpeta = join(carpetaArchivos(), tipo);
  await mkdir(carpeta, { recursive: true });
  const ruta = join(carpeta, nombre);
  await escribirAtomico(ruta, datos);
  return { fotoUrl: `/uploads/${tipo}/${nombre}`, ruta, bytes: datos.length };
}

export async function guardarFotoPublica(tipo: TipoFoto, id: string, imagen: string) {
  validarId(id);
  const datos = datosImagen(imagen, tipo === 'socios' ? 2 * 1024 * 1024 : 1.5 * 1024 * 1024);
  return guardarWebp(tipo, id, await normalizarFoto(datos, tipo));
}

export async function guardarFotoConvertida(tipo: TipoFoto, id: string, original: Buffer) {
  validarId(id);
  return guardarWebp(tipo, id, await normalizarFoto(original, tipo));
}

export function esFotoWebpActual(tipo: TipoFoto, id: string, url: string) {
  validarId(id);
  return new RegExp(`^/uploads/${tipo}/${id}-${VERSION}-[a-f0-9]{24}\\.webp$`).test(url || '');
}

/** Sólo archivos locales del registro, sin rutas externas, traversal ni symlinks. */
export async function rutaFotoLocal(tipo: TipoFoto, id: string, url: string): Promise<string | null> {
  validarId(id);
  const nombre = (url || '').split('?')[0];
  if (!new RegExp(`^/uploads/${tipo}/${id}(?:\\.(?:jpg|jpeg|png|webp)|-${VERSION}-[a-f0-9]{24}\\.webp)$`, 'i').test(nombre)) return null;
  const carpeta = resolve(carpetaArchivos(), tipo);
  const ruta = resolve(carpetaArchivos(), nombre.slice('/uploads/'.length));
  try {
    const [archivoStat, carpetaStat, raizStat] = await Promise.all([lstat(ruta), lstat(carpeta), lstat(resolve(carpetaArchivos()))]);
    if (!archivoStat.isFile() || carpetaStat.isSymbolicLink() || raizStat.isSymbolicLink()) return null;
    const [baseReal, archivoReal] = await Promise.all([realpath(carpeta), realpath(ruta)]);
    if (archivoReal !== join(baseReal, basename(ruta))) return null;
    return ruta;
  } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
}

/** La supresión del socio también elimina originales conservados por la conversión. */
export async function eliminarFotos(tipo: TipoFoto, id: string, conservar?: string) {
  validarId(id);
  const carpeta = join(carpetaArchivos(), tipo);
  const conservado = conservar?.split('/').pop();
  const patron = new RegExp(`^${id}(?:\\.(?:jpg|jpeg|png|webp)|-${VERSION}-[a-f0-9]{24}\\.webp)(?:\\.[a-f0-9-]+\\.tmp)?$`, 'i');
  for (const nombre of await readdir(carpeta).catch((e: any) => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (nombre !== conservado && patron.test(nombre)) await unlink(join(carpeta, nombre)).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
  }
  await unlink(join(carpetaPrivada(), 'imagenes-webp', tipo, `${id}.json`)).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
}
