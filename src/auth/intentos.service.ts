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

  /**
   * El hash se compara fuera de la transaccion. El primer UPDATE toma el bloqueo
   * de fila y vuelve a comprobar credencial, version, vigencia y bloqueo actual.
   * Asi ningun resultado de bcrypt puede sobrescribir un reset o perder fallos
   * por haber leido el mismo contador que otra peticion o replica.
   */
  async confirmar(
    tipo: 'staff' | 'socio',
    esperado: { id: string; hash: string; version: number; identificador: string },
    exito: boolean,
    ip?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const ahora = new Date();
      const bloqueoPermitido = { OR: [{ bloqueadoHasta: null }, { bloqueadoHasta: { lte: ahora } }] };
      const datos = { intentosFallidos: exito ? 0 : { increment: 1 }, bloqueadoHasta: null };
      const actualizado = tipo === 'staff'
        ? await tx.user.updateMany({ where: { id: esperado.id, email: esperado.identificador, passwordHash: esperado.hash, sessionVersion: esperado.version, activo: true, ...bloqueoPermitido }, data: datos })
        : await tx.member.updateMany({ where: {
          id: esperado.id, dni: esperado.identificador, pinHash: esperado.hash, portalVersion: esperado.version, activo: true,
          AND: [bloqueoPermitido, { OR: [{ pinCambiado: true }, { pinCambiado: false, pinTemporalHasta: { gt: ahora } }] }],
        }, data: datos });
      let registro: any = tipo === 'staff'
        ? await tx.user.findUnique({ where: { id: esperado.id } })
        : await tx.member.findUnique({ where: { id: esperado.id } });
      if (actualizado.count === 1 && !exito && registro.intentosFallidos >= this.MAX_INTENTOS) {
        const data = { intentosFallidos: 0, bloqueadoHasta: new Date(ahora.getTime() + this.BLOQUEO_MIN * 60000) };
        registro = tipo === 'staff'
          ? await tx.user.update({ where: { id: esperado.id }, data })
          : await tx.member.update({ where: { id: esperado.id }, data });
      }
      const temporalVigente = tipo === 'staff' || registro?.pinCambiado || (registro?.pinTemporalHasta?.getTime() > Date.now());
      const permitido = actualizado.count === 1 && exito && Boolean(temporalVigente);
      await tx.loginAttempt.create({ data: { tipo, identificador: esperado.identificador, exito: permitido, ip: ip || null } });
      return { permitido, registro, restantes: registro ? Math.max(0, this.MAX_INTENTOS - registro.intentosFallidos) : 0 };
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
