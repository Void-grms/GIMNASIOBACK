import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

import { MENSAJE_NUEVO, MENSAJE_RENOVACION } from './plantillas';

const fechaLarga = (d: Date) =>
  d.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const soles = (n: number) => `S/ ${n.toFixed(2)}`;

/**
 * Mensaje de WhatsApp despues de cobrar una membresia.
 *
 * WhatsApp (wa.me) no permite adjuntar archivos desde un enlace, asi que la
 * boleta viaja como link a una pagina publica firmada: quien no tiene la firma
 * no puede abrir pagos ajenos cambiando el id. Si el comprobante no se pudo
 * emitir (por ejemplo, falta el RUC), el link muestra una constancia de pago.
 */
@Injectable()
export class MessagesService {
  private readonly secreto = process.env.QR_SECRET || process.env.JWT_SECRET || 'desarrollo';

  constructor(private prisma: PrismaService, private settings: SettingsService) {}

  firma(paymentId: string) {
    return createHmac('sha256', this.secreto).update(`pago:${paymentId}`).digest('base64url').slice(0, 22);
  }

  private firmaValida(paymentId: string, t?: string) {
    if (!t) return false;
    const esperada = Buffer.from(this.firma(paymentId));
    const recibida = Buffer.from(t);
    return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
  }

  private async pago(paymentId: string) {
    const pago = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        member: true,
        membership: { include: { plan: true } },
        receipt: { include: { items: true } },
      },
    });
    if (!pago) throw new NotFoundException('Pago no encontrado');
    return pago;
  }

  /** Lo que ve recepcion antes de enviar: texto armado, telefono y enlace. */
  async paraWhatsapp(paymentId: string, origen: string) {
    const pago = await this.pago(paymentId);
    if (!pago.membership || !pago.member) {
      throw new BadRequestException('Solo se envia el mensaje de pagos de membresia');
    }
    const ajustes = await this.settings.obtener();

    // Renovacion si ya tenia una membresia anterior a esta; si no, es nuevo.
    const anteriores = await this.prisma.membership.count({
      where: { memberId: pago.memberId!, createdAt: { lt: pago.membership.createdAt } },
    });
    const esRenovacion = anteriores > 0;
    const plantilla = esRenovacion
      ? ajustes.mensajeCobroRenovacion || MENSAJE_RENOVACION
      : ajustes.mensajeCobroNuevo || MENSAJE_NUEVO;

    const base = (origen || '').replace(/\/+$/, '');
    const enlace = `${base}/pago/${pago.id}?t=${this.firma(pago.id)}`;
    const r = pago.receipt;
    const comprobante =
      r && !r.anulado
        ? `${r.tipo === 'recibo' ? 'recibo' : r.tipo} ${r.serie}-${String(r.numero).padStart(6, '0')}`
        : 'constancia de pago';
    const dias =
      Math.round((pago.membership.fechaFin.getTime() - pago.membership.fechaInicio.getTime()) / 86400000) + 1;

    const valores: Record<string, string> = {
      '{nombre}': pago.member.nombres.split(' ')[0],
      '{gimnasio}': ajustes.nombreComercial || 'el gimnasio',
      '{plan}': pago.membership.plan.nombre,
      '{inicio}': fechaLarga(pago.membership.fechaInicio),
      '{vence}': fechaLarga(pago.membership.fechaFin),
      '{dias}': String(dias),
      '{monto}': soles(pago.monto),
      '{metodo}': pago.metodo,
      '{comprobante}': comprobante,
      '{enlace}': enlace,
      '{portal}': `${base}/portal`,
    };
    const mensaje = plantilla.replace(/\{[a-z]+\}/g, (v) => valores[v] ?? v);

    const envios = await this.prisma.notification.findMany({
      where: { paymentId, tipo: 'cobro' },
      orderBy: { enviadoAt: 'desc' },
      take: 1,
    });

    return {
      tipo: esRenovacion ? 'renovacion' : 'nuevo',
      telefono: pago.member.telefono || '',
      socio: `${pago.member.nombres} ${pago.member.apellidos}`,
      mensaje,
      enlace,
      enviadoAt: envios[0]?.enviadoAt ?? null,
    };
  }

  async registrarEnvio(paymentId: string, mensaje: string) {
    const pago = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!pago?.memberId) throw new NotFoundException('Pago no encontrado');
    await this.prisma.notification.create({
      data: {
        memberId: pago.memberId,
        tipo: 'cobro',
        canal: 'whatsapp',
        mensaje: (mensaje || '').slice(0, 2000),
        paymentId,
      },
    });
    return { ok: true };
  }

  /** Pagina publica del link: comprobante si lo hay, constancia si no. */
  async publico(paymentId: string, t?: string) {
    if (!this.firmaValida(paymentId, t)) throw new NotFoundException('Enlace no valido');
    const pago = await this.pago(paymentId);
    const ajustes = await this.settings.obtener();
    return {
      gimnasio: {
        nombre: ajustes.nombreComercial,
        razonSocial: ajustes.razonSocial,
        ruc: ajustes.ruc,
        direccion: ajustes.direccionFiscal,
        telefono: ajustes.telefono,
      },
      pago: {
        id: pago.id,
        fecha: pago.fecha,
        monto: pago.monto,
        metodo: pago.metodo,
      },
      socio: pago.member ? { nombreCompleto: `${pago.member.nombres} ${pago.member.apellidos}` } : null,
      membresia: pago.membership
        ? {
            plan: pago.membership.plan.nombre,
            inicio: pago.membership.fechaInicio.toISOString().slice(0, 10),
            vence: pago.membership.fechaFin.toISOString().slice(0, 10),
            anulada: pago.membership.estado === 'anulada',
          }
        : null,
      comprobante: pago.receipt ?? null,
    };
  }
}
