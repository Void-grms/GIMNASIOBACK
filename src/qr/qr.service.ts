import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Credencial QR rotativa.
 *
 * El codigo NO es el id del socio: es una firma que caduca. Cambia cada
 * VENTANA_SEG segundos, asi una foto del QR enviada por WhatsApp sirve, como
 * mucho, un minuto y medio. Se acepta la ventana anterior y la siguiente para
 * tolerar relojes desfasados.
 *
 * Formato: G1.<memberId>.<ventana>.<firma>
 */
@Injectable()
export class QrService {
  private readonly VENTANA_SEG = 30;
  private readonly TOLERANCIA = 1;
  private readonly secretoServidor = process.env.QR_SECRET || 'dev-qr-secret';

  nuevoSecreto(): string {
    return randomBytes(24).toString('base64url');
  }

  private ventanaActual(ahora: Date = new Date()): number {
    return Math.floor(ahora.getTime() / 1000 / this.VENTANA_SEG);
  }

  private firmar(memberId: string, secretoSocio: string, ventana: number): string {
    return createHmac('sha256', `${this.secretoServidor}.${secretoSocio}`)
      .update(`${memberId}.${ventana}`)
      .digest('base64url')
      .slice(0, 12);
  }

  /** Codigo que muestra el portal del socio. Se regenera solo cada 30 s. */
  generar(memberId: string, secretoSocio: string, ahora: Date = new Date()) {
    const ventana = this.ventanaActual(ahora);
    const codigo = `G1.${memberId}.${ventana}.${this.firmar(memberId, secretoSocio, ventana)}`;
    const venceEn = (ventana + 1) * this.VENTANA_SEG * 1000 - ahora.getTime();
    return { codigo, venceEnMs: venceEn, ventanaSeg: this.VENTANA_SEG };
  }

  /** Extrae el memberId sin validar la firma (para poder buscar su secreto). */
  leerMemberId(codigo: string): string | null {
    const partes = (codigo || '').trim().split('.');
    if (partes.length !== 4 || partes[0] !== 'G1') return null;
    return partes[1] || null;
  }

  /** Valida firma y vigencia contra el secreto del socio. */
  validar(codigo: string, secretoSocio: string, ahora: Date = new Date()): boolean {
    const partes = (codigo || '').trim().split('.');
    if (partes.length !== 4 || partes[0] !== 'G1') return false;
    const [, memberId, ventanaTxt, firma] = partes;
    const ventana = Number(ventanaTxt);
    if (!Number.isFinite(ventana)) return false;

    const actual = this.ventanaActual(ahora);
    if (Math.abs(actual - ventana) > this.TOLERANCIA) return false;

    const esperada = this.firmar(memberId, secretoSocio, ventana);
    const a = Buffer.from(esperada);
    const b = Buffer.from(firma);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
