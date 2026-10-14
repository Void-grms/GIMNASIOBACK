import { BadRequestException } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';

export const DURACION_ACCESO_MS = 24 * 60 * 60 * 1000;

export function validarDniPortal(dni: unknown): string {
  const valor = String(dni ?? '').trim();
  if (!/^\d{8}$/.test(valor)) throw new BadRequestException('Completa un DNI valido de 8 digitos antes de habilitar el portal');
  return valor;
}

export function validarPin(pin: unknown, dni?: string | null, codigoERP?: string | null): string {
  const valor = String(pin ?? '');
  if (!/^\d{4}$/.test(valor)) throw new BadRequestException('El PIN debe tener 4 digitos');
  const secuencias = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', '7890', '9876', '8765', '7654', '6543', '5432', '4321', '3210', '0987'];
  if (/^(\d)\1{3}$/.test(valor) || secuencias.includes(valor)) {
    throw new BadRequestException('Ese PIN es demasiado facil de adivinar');
  }
  if (valor === codigoERP || (dni && valor === dni.slice(-4))) {
    throw new BadRequestException('Elige un PIN distinto de tu codigo de asistencia y de los ultimos digitos de tu DNI');
  }
  return valor;
}

export function pinAleatorio(dni?: string | null, codigoERP?: string | null): string {
  for (;;) {
    const valor = String(randomInt(0, 10000)).padStart(4, '0');
    try { return validarPin(valor, dni, codigoERP); } catch { /* generar otro PIN */ }
  }
}

export function hashToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw new BadRequestException('El enlace de activacion no es valido o ha vencido');
  return createHash('sha256').update(token).digest('hex');
}

/** No propagar hashes de PIN ni secretos/activaciones en respuestas. */
export function sinSecretos<T extends Record<string, any>>(socio: T) {
  const { pinHash, credential, activacionesPortal, ...publico } = socio;
  return publico;
}

export function estadoPortal(socio: Record<string, any>): string {
  if (!socio.activo) return 'inactivo';
  if (!/^\d{8}$/.test(socio.dni || '')) return 'sin_dni';
  if (socio.pinCambiado) return 'activo';
  if (socio.pinTemporalHasta && new Date(socio.pinTemporalHasta).getTime() > Date.now()) return 'pin_temporal';
  return 'pendiente_activacion';
}

export function consentimientoPendiente(socio: Record<string, any>): boolean {
  return !socio.consents?.some((c: any) => c.tipo === 'datos_personales' && c.aceptado === true);
}
