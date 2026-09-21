import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from '../members/members.service';
import { QrService } from '../qr/qr.service';
import { IntentosService } from '../auth/intentos.service';
import { diaLimaDe, formatoFecha } from '../common/fechas';

@Injectable()
export class PortalService {
  constructor(
    private prisma: PrismaService,
    private members: MembersService,
    private qr: QrService,
    private jwt: JwtService,
    private intentos: IntentosService,
  ) {}

  /**
   * Login del socio: DNI + PIN de 4 digitos (por defecto los ultimos 4 del DNI).
   * Es deliberadamente simple porque nadie recuerda una contrasena que usa una
   * vez al mes. Si el portal llega a mostrar datos sensibles, cambiar a codigo
   * por WhatsApp.
   */
  async login(dni: string, pin: string, ip?: string) {
    const socio = await this.members.porDni(dni);
    const generico = 'DNI o PIN incorrectos';

    if (!socio || !socio.activo) {
      await this.intentos.registrar('socio', dni, false, ip);
      throw new UnauthorizedException(generico);
    }

    this.intentos.verificarBloqueo(socio.bloqueadoHasta);

    if (!bcrypt.compareSync(pin, socio.pinHash)) {
      const { intentos, bloqueadoHasta } = this.intentos.siguienteBloqueo(socio.intentosFallidos);
      await this.prisma.member.update({
        where: { id: socio.id },
        data: { intentosFallidos: intentos, bloqueadoHasta },
      });
      await this.intentos.registrar('socio', dni, false, ip);

      if (bloqueadoHasta) {
        throw new UnauthorizedException(
          'Demasiados intentos. Espera 15 minutos o pide tu PIN en recepcion.',
        );
      }
      throw new UnauthorizedException(
        `${generico}. Te quedan ${this.intentos.intentosRestantes(socio.intentosFallidos)} intento(s).`,
      );
    }

    await this.prisma.member.update({
      where: { id: socio.id },
      data: { intentosFallidos: 0, bloqueadoHasta: null },
    });
    await this.intentos.registrar('socio', dni, true, ip);

    // La sesion dura poco mientras el PIN siga siendo el que entrego recepcion.
    const token = await this.jwt.signAsync(
      { sub: socio.id, tipo: 'socio', nombre: socio.nombres },
      { expiresIn: socio.pinCambiado ? '30d' : '1h' },
    );
    return {
      access_token: token,
      debeCambiarPin: !socio.pinCambiado,
      socio: this.members.resumen(socio, null),
    };
  }

  async miPanel(memberId: string) {
    const socio = await this.prisma.member.findUnique({
      where: { id: memberId },
      include: {
        payments: { orderBy: { fecha: 'desc' }, take: 10 },
        checkIns: {
          where: { resultado: 'permitido' },
          orderBy: { timestamp: 'desc' },
          take: 30,
        },
      },
    });
    if (!socio) throw new NotFoundException('Socio no encontrado');

    const membresia = await this.members.membresiaVigente(memberId);
    const dentro = await this.members.estaDentro(memberId);
    return {
      ...this.members.resumen(socio, membresia, dentro),
      email: socio.email,
      debeCambiarPin: !socio.pinCambiado,
      racha: this.racha(socio.checkIns.map((c) => c.timestamp)),
      asistenciasMes: socio.checkIns.filter(
        (c) => c.timestamp.getTime() > Date.now() - 30 * 24 * 3600 * 1000,
      ).length,
      ultimasVisitas: socio.checkIns.slice(0, 10).map((c) => c.timestamp),
      pagos: socio.payments.map((p) => ({
        id: p.id,
        monto: p.monto,
        metodo: p.metodo,
        fecha: diaLimaDe(p.fecha),
      })),
    };
  }

  /** Dias seguidos asistiendo, contando desde la ultima visita hacia atras. */
  private racha(visitas: Date[]): number {
    if (!visitas.length) return 0;
    const dias = Array.from(new Set(visitas.map((v) => diaLimaDe(v)))).sort().reverse();
    let racha = 1;
    for (let i = 1; i < dias.length; i++) {
      const anterior = new Date(dias[i - 1] + 'T00:00:00Z').getTime();
      const actual = new Date(dias[i] + 'T00:00:00Z').getTime();
      if (anterior - actual === 24 * 3600 * 1000) racha++;
      else break;
    }
    return racha;
  }

  /** Codigo QR rotativo del socio. El portal lo pide cada 30 segundos. */
  async miQr(memberId: string) {
    const credencial = await this.prisma.credential.findUnique({ where: { memberId } });
    if (!credencial || !credencial.activo) {
      throw new NotFoundException('Este socio no tiene credencial QR activa');
    }
    return this.qr.generar(memberId, credencial.secret);
  }

  /**
   * El socio edita lo suyo: contacto y PIN. No puede tocar su nombre ni su DNI
   * (eso lo corrige recepcion con el documento delante) ni su membresia.
   */
  async actualizarPerfil(
    memberId: string,
    dto: { telefono?: string; email?: string; pinActual?: string; pinNuevo?: string },
  ) {
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio) throw new NotFoundException('Socio no encontrado');

    const data: Record<string, any> = {};
    if (dto.telefono !== undefined) data.telefono = dto.telefono.trim() || null;
    if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase() || null;

    if (dto.pinNuevo) {
      const nuevo = dto.pinNuevo.replace(/\D/g, '');
      if (nuevo.length !== 4) throw new BadRequestException('El PIN nuevo debe tener 4 digitos');
      if (!dto.pinActual || !bcrypt.compareSync(dto.pinActual, socio.pinHash)) {
        throw new BadRequestException('El PIN actual no coincide');
      }
      if (nuevo === dto.pinActual) {
        throw new BadRequestException('El PIN nuevo tiene que ser distinto del actual');
      }
      if (/^(\d)\1{3}$/.test(nuevo) || ['1234', '0123', '4321'].includes(nuevo)) {
        throw new BadRequestException('Ese PIN es demasiado facil de adivinar');
      }
      data.pinHash = bcrypt.hashSync(nuevo, 10);
      data.pinCambiado = true;
    }

    await this.prisma.member.update({ where: { id: memberId }, data });
    return { ok: true };
  }

  /** Selfie del socio desde su propio celular. */
  async actualizarFoto(memberId: string, imagen: string) {
    await this.members.guardarFoto(memberId, imagen);
    return { ok: true };
  }
}
