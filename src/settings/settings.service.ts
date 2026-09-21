import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Regimenes que si trasladan IGV. El NRUS paga cuota fija y no lo desglosa. */
const REGIMENES_CON_IGV = ['rer', 'rmt', 'general'];

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  /** Siempre existe: si no esta, se crea con los valores por defecto. */
  async obtener() {
    return this.prisma.settings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default' },
    });
  }

  async actualizar(dto: Record<string, any>) {
    const campos = [
      'razonSocial', 'nombreComercial', 'ruc', 'direccionFiscal', 'telefono', 'email',
      'regimen', 'igvTasa', 'umbralDocumento',
      'pseProveedor', 'pseRuc', 'pseToken', 'pseUrl', 'invitadosPorMes',
      'terminosVersion', 'terminosTexto',
      'privacidadVersion', 'privacidadTexto',
      'consentimientoVersion', 'consentimientoTexto',
      'yapeNumero', 'yapeTitular', 'aforoMaximo', 'mostrarAforo',
    ];
    const data: Record<string, any> = {};
    for (const campo of campos) if (dto[campo] !== undefined) data[campo] = dto[campo];

    await this.obtener();
    return this.prisma.settings.update({ where: { id: 'default' }, data });
  }

  /** Lo que el frontend necesita saber para armar el formulario de cobro. */
  async publico() {
    const s = await this.obtener();
    return {
      razonSocial: s.razonSocial,
      nombreComercial: s.nombreComercial,
      ruc: s.ruc,
      direccionFiscal: s.direccionFiscal,
      telefono: s.telefono,
      email: s.email,
      regimen: s.regimen,
      aplicaIgv: REGIMENES_CON_IGV.includes(s.regimen),
      igvTasa: s.igvTasa,
      emiteFactura: REGIMENES_CON_IGV.includes(s.regimen),
      umbralDocumento: s.umbralDocumento,
      invitadosPorMes: s.invitadosPorMes,
      emisionElectronica: s.pseProveedor !== 'ninguno',
      terminosVersion: s.terminosVersion,
      terminosTexto: s.terminosTexto,
      privacidadVersion: s.privacidadVersion,
      privacidadTexto: s.privacidadTexto,
      consentimientoVersion: s.consentimientoVersion,
      consentimientoTexto: s.consentimientoTexto,
      yapeNumero: s.yapeNumero,
      yapeTitular: s.yapeTitular,
      aforoMaximo: s.aforoMaximo,
      mostrarAforo: s.mostrarAforo,
    };
  }

  /** Deja constancia del ultimo respaldo sin pasar por la validacion de ajustes. */
  async actualizarRespaldo(archivo: string) {
    await this.obtener();
    return this.prisma.settings.update({
      where: { id: 'default' },
      data: { ultimoRespaldoAt: new Date(), ultimoRespaldoArchivo: archivo },
    });
  }

  aplicaIgv(regimen: string) {
    return REGIMENES_CON_IGV.includes(regimen);
  }
}
