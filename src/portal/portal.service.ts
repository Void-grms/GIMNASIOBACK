import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from '../members/members.service';
import { QrService } from '../qr/qr.service';
import { IntentosService } from '../auth/intentos.service';
import { diaLimaDe } from '../common/fechas';
import { validarPin } from '../members/acceso.util';

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
   * Login del socio: DNI + PIN elegido, o temporal con vencimiento real.
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

    if (!socio.pinCambiado && (!socio.pinTemporalHasta || socio.pinTemporalHasta.getTime() <= Date.now())) {
      throw new UnauthorizedException('El acceso temporal no esta vigente. Solicita un PIN o enlace en recepcion');
    }

    await this.prisma.member.update({
      where: { id: socio.id },
      data: { intentosFallidos: 0, bloqueadoHasta: null },
    });
    await this.intentos.registrar('socio', dni, true, ip);

    // La sesion dura poco mientras el PIN siga siendo el que entrego recepcion.
    const token = await this.tokenSesion(socio);
    return {
      access_token: token,
      debeCambiarPin: !socio.pinCambiado,
      socio: socio.pinCambiado ? this.members.resumen(socio, null) : this.perfilMinimo(socio),
    };
  }

  private tokenSesion(socio: any) {
    const expiresIn = socio.pinCambiado ? 30 * 24 * 3600 : Math.min(3600, Math.floor((socio.pinTemporalHasta.getTime() - Date.now()) / 1000));
    if (expiresIn <= 0) throw new UnauthorizedException('El PIN temporal ha vencido');
    return this.jwt.signAsync({ sub: socio.id, tipo: 'socio', nombre: socio.nombres, portalVersion: socio.portalVersion, debeCambiarPin: !socio.pinCambiado }, { expiresIn });
  }

  private perfilMinimo(socio: any) {
    return {
      id: socio.id, dni: socio.dni, nombres: socio.nombres, apellidos: socio.apellidos,
      nombreCompleto: `${socio.nombres} ${socio.apellidos}`, telefono: socio.telefono, email: socio.email,
      debeCambiarPin: true, pinTemporalHasta: socio.pinTemporalHasta?.toISOString() ?? null, estadoPortal: 'pin_temporal',
    };
  }

  async miPanel(memberId: string) {
    const perfil = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!perfil) throw new NotFoundException('Socio no encontrado');
    if (!perfil.pinCambiado) return this.perfilMinimo(perfil);
    const socio = await this.prisma.member.findUnique({
      where: { id: memberId },
      include: {
        consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1, select: { tipo: true, aceptado: true } },
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
    const casillero = await this.prisma.locker.findUnique({ where: { memberId } });
    return {
      ...this.members.resumen(socio, membresia, dentro),
      email: socio.email,
      debeCambiarPin: !socio.pinCambiado,
      ocultarEnRanking: socio.ocultarEnRanking,
      casillero: casillero?.numero ?? null,
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
    dto: {
      telefono?: string;
      email?: string;
      pinActual?: string;
      pinNuevo?: string;
      ocultarEnRanking?: boolean;
    },
    version?: number,
  ) {
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio) throw new NotFoundException('Socio no encontrado');
    if (!socio.activo || (version !== undefined && version !== socio.portalVersion)) throw new UnauthorizedException('Tu acceso cambio. Vuelve a iniciar sesion');
    if (!socio.pinCambiado) {
      if (!socio.pinTemporalHasta || socio.pinTemporalHasta.getTime() <= Date.now()) throw new UnauthorizedException('El PIN temporal ha vencido');
      if (!dto.pinNuevo) throw new BadRequestException('Cambia tu PIN temporal antes de editar el perfil');
    }

    const data: Record<string, any> = {};
    if (dto.telefono !== undefined) data.telefono = dto.telefono.trim() || null;
    if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase() || null;
    if (dto.ocultarEnRanking !== undefined) data.ocultarEnRanking = dto.ocultarEnRanking;

    if (dto.pinNuevo) {
      const nuevo = validarPin(dto.pinNuevo, socio.dni, socio.codigoERP);
      if (!dto.pinActual || !bcrypt.compareSync(dto.pinActual, socio.pinHash)) {
        throw new BadRequestException('El PIN actual no coincide');
      }
      if (nuevo === dto.pinActual) {
        throw new BadRequestException('El PIN nuevo tiene que ser distinto del actual');
      }
      data.pinHash = bcrypt.hashSync(nuevo, 10);
      data.pinCambiado = true;
      data.pinTemporalHasta = null;
      data.portalVersion = { increment: 1 };
      data.intentosFallidos = 0;
      data.bloqueadoHasta = null;
    }

    const actualizado = await this.prisma.$transaction(async (tx) => {
      const resultado = await tx.member.updateMany({ where: { id: memberId, activo: true, portalVersion: socio.portalVersion }, data });
      if (resultado.count !== 1) throw new UnauthorizedException('Tu acceso cambio. Vuelve a iniciar sesion');
      if (dto.pinNuevo || (dto.telefono !== undefined && data.telefono !== socio.telefono)) {
        await tx.portalActivation.updateMany({ where: { memberId, usedAt: null }, data: { usedAt: new Date() } });
      }
      return tx.member.findUnique({ where: { id: memberId } });
    });
    return dto.pinNuevo ? { ok: true, access_token: await this.tokenSesion(actualizado), debeCambiarPin: false } : { ok: true };
  }

  /** Selfie del socio desde su propio celular. */
  async actualizarFoto(memberId: string, imagen: string) {
    await this.members.guardarFoto(memberId, imagen);
    return { ok: true };
  }
}
