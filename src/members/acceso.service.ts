import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Prisma, Member } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { DURACION_ACCESO_MS, hashToken, pinAleatorio, validarDniPortal, validarPin } from './acceso.util';
import { hashPassword } from '../common/password';

export type VerificacionAcceso = { identidadVerificada: boolean; consentimiento?: boolean; consentimientoVersion?: string; consentimientoHuella?: string };

@Injectable()
export class AccesoService {
  constructor(private prisma: PrismaService, private settings: SettingsService) {}

  private verificarIdentidad(dto: VerificacionAcceso) {
    if (dto.identidadVerificada !== true) throw new BadRequestException('Recepcion debe verificar la identidad del socio');
  }

  private verificarSocio(socio: Member | null) {
    if (!socio) throw new NotFoundException('Socio no encontrado');
    if (!socio.activo) throw new BadRequestException('El socio esta dado de baja');
    validarDniPortal(socio.dni);
    return socio;
  }

  /** El booleano confirma una aceptacion real; no se deriva de la importacion. */
  private verificarVersionConsentimiento(version: string | undefined, huella: string | undefined, ajustes: any) {
    if (!ajustes.consentimientoTexto?.trim()) throw new BadRequestException('Configura el texto de consentimiento antes de habilitar el portal');
    const actual = createHash('sha256').update(ajustes.consentimientoTexto, 'utf8').digest('hex');
    if (version !== ajustes.consentimientoVersion || huella !== actual) throw new BadRequestException('El texto de consentimiento cambio. Recarga y revisalo de nuevo');
  }

  async registrarConsentimientoSiPendiente(tx: Prisma.TransactionClient, memberId: string, dto: VerificacionAcceso, origen: string, ajustes: any, ip?: string) {
    if (dto.consentimiento === true) this.verificarVersionConsentimiento(dto.consentimientoVersion, dto.consentimientoHuella, ajustes);
    const existente = await tx.consent.findFirst({ where: { memberId, tipo: 'datos_personales', aceptado: true } });
    if (existente) return;
    if (dto.consentimiento !== true) throw new BadRequestException('Registra la aceptacion del socio al tratamiento de datos antes de habilitar el portal');
    await tx.consent.create({ data: {
      memberId, tipo: 'datos_personales', aceptado: true,
      version: ajustes.consentimientoVersion, texto: ajustes.consentimientoTexto, origen, ip: ip || null,
    } });
  }

  async emitirPin(memberId: string, dto: VerificacionAcceso, ip?: string) {
    this.verificarIdentidad(dto);
    const ajustes = await this.settings.obtener();
    const observado = this.verificarSocio(await this.prisma.member.findUnique({ where: { id: memberId } }));
    const pinInicial = pinAleatorio(observado.dni, observado.codigoERP);
    const pinHash = await hashPassword(pinInicial);
    const vence = new Date(Date.now() + DURACION_ACCESO_MS);
    const resultado = await this.prisma.$transaction(async (tx) => {
      const cambiado = await tx.member.updateMany({ where: { id: memberId, activo: true, dni: observado.dni, portalVersion: observado.portalVersion, pinHash: observado.pinHash }, data: {
        pinHash, pinCambiado: false, pinTemporalHasta: vence,
        portalVersion: { increment: 1 }, intentosFallidos: 0, bloqueadoHasta: null,
      } });
      if (cambiado.count !== 1) throw new BadRequestException('La identidad o el acceso cambio. Verifica al socio de nuevo');
      await this.registrarConsentimientoSiPendiente(tx, memberId, dto, 'recepcion_acceso', ajustes, ip);
      await tx.portalActivation.updateMany({ where: { memberId, usedAt: null }, data: { usedAt: new Date() } });
      return { socio: await tx.member.findUnique({ where: { id: memberId } }), pinInicial };
    });
    return { pinInicial: resultado.pinInicial, vence: vence.toISOString(), dni: resultado.socio.dni, codigoERP: resultado.socio.codigoERP };
  }

  /** PORTAL_URL es la base del portal (p. ej. https://gym.example/portal). */
  private basePortal(): string {
    let url: URL;
    try { url = new URL(process.env.PORTAL_URL || ''); }
    catch { throw new BadRequestException('Configura PORTAL_URL antes de generar invitaciones'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new BadRequestException('PORTAL_URL debe ser la direccion base http/https del portal');
    }
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new BadRequestException('PORTAL_URL debe usar HTTPS en produccion');
    }
    return url.toString().replace(/\/+$/, '');
  }

  async emitirActivacion(memberId: string, dto: VerificacionAcceso, ip?: string) {
    this.verificarIdentidad(dto);
    const base = this.basePortal();
    const ajustes = await this.settings.obtener();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + DURACION_ACCESO_MS);
    const socio = await this.prisma.$transaction(async (tx) => {
      // Serializa invitaciones concurrentes sin revocar el PIN o la sesion actual.
      await tx.member.updateMany({ where: { id: memberId }, data: { portalVersion: { increment: 0 } } });
      const bloqueado = this.verificarSocio(await tx.member.findUnique({ where: { id: memberId } }));
      if (dto.consentimiento === true) await this.registrarConsentimientoSiPendiente(tx, memberId, dto, 'recepcion_invitacion', ajustes, ip);
      await tx.portalActivation.updateMany({ where: { memberId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.portalActivation.create({ data: { memberId, tokenHash, expiresAt } });
      return bloqueado;
    });
    const enlace = `${base}/activar#token=${token}`;
    const enlaceBienvenida = `${base}/bienvenida`;
    const mensaje = `Hola ${socio.nombres.split(' ')[0]}, estamos renovando el sistema de FORCES GYM para que consultes tu membresia y tengas tu QR desde el celular.\n\nTu codigo de asistencia${socio.codigoERP ? ` ${socio.codigoERP}` : ''} sigue vigente en recepcion. Para entrar al portal usaras tu DNI y un PIN personal que elegiras al activar tu cuenta.\n\nActiva tu acceso aqui: ${enlace}\nEste enlace es personal, vence en 24 horas y se usa una sola vez.\n\nConoce el nuevo portal y los pasos para entrar: ${enlaceBienvenida}\nSi necesitas ayuda o falta completar tu DNI, acercate a recepcion.`;
    const telefono = (socio.telefono || '').replace(/\D/g, '');
    const internacional = /^9\d{8}$/.test(telefono) ? `51${telefono}` : /^519\d{8}$/.test(telefono) ? telefono : null;
    return { enlace, enlaceBienvenida, mensaje, whatsappUrl: internacional ? `https://wa.me/${internacional}?text=${encodeURIComponent(mensaje)}` : null, expiresAt: expiresAt.toISOString() };
  }

  async consultarActivacion(token: string) {
    const activacion = await this.prisma.portalActivation.findUnique({ where: { tokenHash: hashToken(token) }, include: { member: true } });
    if (!activacion || activacion.usedAt || activacion.expiresAt.getTime() <= Date.now() || !activacion.member.activo || !/^\d{8}$/.test(activacion.member.dni || '')) {
      throw new BadRequestException('El enlace de activacion no es valido o ha vencido');
    }
    return { nombre: activacion.member.nombres.split(' ')[0], dniUltimos4: activacion.member.dni.slice(-4), expiresAt: activacion.expiresAt.toISOString() };
  }

  async consumirActivacion(dto: { token: string; dni: string; pin: string; pinConfirmacion: string; consentimiento: boolean; consentimientoVersion: string; consentimientoHuella: string }, ip?: string) {
    const tokenHash = hashToken(dto.token);
    const dni = validarDniPortal(dto.dni);
    const pin = validarPin(dto.pin, dni);
    if (pin !== dto.pinConfirmacion) throw new BadRequestException('La confirmacion del PIN no coincide');
    if (dto.consentimiento !== true) throw new BadRequestException('Debes aceptar el tratamiento de datos personales');
    const ajustes = await this.settings.obtener();
    this.verificarVersionConsentimiento(dto.consentimientoVersion, dto.consentimientoHuella, ajustes);
    const observado = await this.prisma.portalActivation.findUnique({ where: { tokenHash }, include: { member: true } });
    if (!observado || observado.usedAt || observado.expiresAt.getTime() <= Date.now() || !observado.member.activo || observado.member.dni !== dni) {
      throw new BadRequestException('El enlace de activacion no es valido o ha vencido');
    }
    validarPin(pin, dni, observado.member.codigoERP);
    const pinHash = await hashPassword(pin);
    await this.prisma.$transaction(async (tx) => {
      // Solo una transaccion puede cambiar la version observada y consumir el token.
      const cambiado = await tx.member.updateMany({ where: {
        id: observado.memberId, activo: true, dni, portalVersion: observado.member.portalVersion, pinHash: observado.member.pinHash,
      }, data: { pinHash, pinCambiado: true, pinTemporalHasta: null, portalVersion: { increment: 1 }, intentosFallidos: 0, bloqueadoHasta: null } });
      if (cambiado.count !== 1) throw new BadRequestException('El enlace de activacion no es valido o ha vencido');
      const now = new Date();
      const consumido = await tx.portalActivation.updateMany({ where: { id: observado.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (consumido.count !== 1) throw new BadRequestException('El enlace de activacion no es valido o ha vencido');
      await tx.portalActivation.updateMany({ where: { memberId: observado.memberId, usedAt: null }, data: { usedAt: now } });
      // Cada aceptacion hecha en esta pantalla conserva el texto y version mostrados.
      await tx.consent.create({ data: { memberId: observado.memberId, tipo: 'datos_personales', aceptado: true, version: ajustes.consentimientoVersion, texto: ajustes.consentimientoTexto, origen: 'portal_activacion', ip: ip || null } });
    });
    return { ok: true };
  }
}
