import { BadRequestException } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Donde viven las fotos de los socios. En la PC de recepcion es ./uploads;
 * en un servidor con disco efimero (Railway) apunta a un volumen montado,
 * p. ej. UPLOADS_DIR=/data/uploads, para que las fotos sobrevivan un deploy.
 */
export const carpetaArchivos = () => process.env.UPLOADS_DIR || join(process.cwd(), 'uploads');

/** true cuando la base es PostgreSQL (define funciones que SQLite no tiene). */
export const esPostgres = () => /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '');

/**
 * Archivos que NO se sirven como estaticos (capturas de pago Yape): viven junto
 * a la carpeta publica, en el mismo volumen, pero fuera de /uploads. Solo el
 * personal los ve, a traves de un endpoint con sesion.
 */
export const carpetaPrivada = () =>
  process.env.PRIVATE_DIR || join(dirname(carpetaArchivos()), 'privado');

/**
 * Guarda una imagen que llega como data URL (lo que produce un <canvas> o un
 * FileReader). Devuelve la extension usada para que quien llama arme la ruta.
 */
export function guardarImagen(
  dataUrl: string,
  carpeta: string,
  nombre: string,
  maxBytes = 2 * 1024 * 1024,
): string {
  const coincide = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
    (dataUrl || '').trim(),
  );
  if (!coincide) throw new BadRequestException('La imagen no tiene un formato valido');
  const binario = Buffer.from(coincide[2], 'base64');
  if (binario.length > maxBytes) {
    throw new BadRequestException(
      `La imagen pesa mas de ${Math.round(maxBytes / 1024 / 1024)} MB. Bajala de resolucion.`,
    );
  }
  const extension = coincide[1] === 'png' ? 'png' : coincide[1] === 'webp' ? 'webp' : 'jpg';
  mkdirSync(carpeta, { recursive: true });
  writeFileSync(join(carpeta, `${nombre}.${extension}`), binario);
  return extension;
}
