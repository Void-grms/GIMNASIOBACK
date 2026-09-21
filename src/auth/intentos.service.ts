import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Control de fuerza bruta.
 *
 * Importa mas de lo que parece en el portal del socio: el usuario es el DNI,
 * que no es secreto, y el PIN tiene cuatro digitos. Sin limite de intentos son
 * diez mil combinaciones, o sea minutos.
 */
@Injectable()
export class IntentosService {
  private readonly MAX_INTENTOS = 5;
  private readonly BLOQUEO_MIN = 15;

  constructor(private prisma: PrismaService) {}

  /** Lanza si la cuenta esta bloqueada. Devuelve los minutos que faltan. */
  verificarBloqueo(bloqueadoHasta: Date | null) {
    if (!bloqueadoHasta) return;
    const restanMs = bloqueadoHasta.getTime() - Date.now();
    if (restanMs > 0) {
      const minutos = Math.ceil(restanMs / 60000);
      throw new UnauthorizedException(
        `Demasiados intentos fallidos. Vuelve a intentar en ${minutos} minuto(s).`,
      );
    }
  }

  async registrar(tipo: 'staff' | 'socio', identificador: string, exito: boolean, ip?: string) {
    await this.prisma.loginAttempt.create({
      data: { tipo, identificador, exito, ip: ip || null },
    });
  }

  /** Suma un fallo y devuelve hasta cuando queda bloqueada la cuenta, si toca. */
  siguienteBloqueo(intentosPrevios: number): { intentos: number; bloqueadoHasta: Date | null } {
    const intentos = intentosPrevios + 1;
    if (intentos >= this.MAX_INTENTOS) {
      return { intentos: 0, bloqueadoHasta: new Date(Date.now() + this.BLOQUEO_MIN * 60000) };
    }
    return { intentos, bloqueadoHasta: null };
  }

  intentosRestantes(intentosPrevios: number) {
    return Math.max(0, this.MAX_INTENTOS - intentosPrevios - 1);
  }
}
