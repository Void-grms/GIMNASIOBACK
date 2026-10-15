import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

// bcrypt nativo usa el pool de libuv; acotar trabajos evita una cola sin limite
// y deja al event loop disponible para asistencia y otras peticiones.
const MAX_ACTIVOS = 4;
const MAX_EN_ESPERA = 256;
let activos = 0;
const espera: Array<() => void> = [];

async function ejecutar<T>(trabajo: () => Promise<T>): Promise<T> {
  if (activos >= MAX_ACTIVOS) {
    if (espera.length >= MAX_EN_ESPERA) throw new ServiceUnavailableException('Hay muchos accesos en curso. Intenta de nuevo en unos segundos');
    await new Promise<void>((resolve) => espera.push(resolve));
  } else activos++;
  try { return await trabajo(); }
  finally {
    const siguiente = espera.shift();
    if (siguiente) siguiente();
    else activos--;
  }
}

export function hashPassword(texto: string, rondas = 10): Promise<string> {
  if (Buffer.byteLength(texto, 'utf8') > 72) throw new BadRequestException('La contrasena debe tener como maximo 72 bytes UTF-8');
  return ejecutar(() => bcrypt.hash(texto, rondas));
}

export function verifyPassword(texto: string, hash: string): Promise<boolean> {
  return ejecutar(() => bcrypt.compare(texto, hash));
}
