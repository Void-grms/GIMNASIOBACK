import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { diasRestantes, formatoFecha, hoyLima, sumarDias } from '../common/fechas';

export type AvisoPendiente = {
  memberId: string;
  nombre: string;
  telefono: string | null;
  plan: string;
  vence: string;
  diasRestantes: number;
  tipo: 'por_vencer' | 'vencido';
  mensaje: string;
  whatsapp: string | null;
  yaAvisado: boolean;
};

@Injectable()
export class NotificationsService {
  /** Se avisa con 3 dias de anticipacion y hasta 7 dias despues del vencimiento. */
  private readonly DIAS_ANTES = Number(process.env.AVISO_DIAS_ANTES || 3);
  private readonly DIAS_DESPUES = Number(process.env.AVISO_DIAS_DESPUES || 7);
  private readonly GIMNASIO = process.env.GIMNASIO_NOMBRE || 'el gimnasio';

  constructor(private prisma: PrismaService) {}

  /**
   * No se envia nada solo: el mensaje sale del WhatsApp del gimnasio con un
   * clic. Automatizar el envio de verdad exige la API de WhatsApp Business,
   * que es un tramite aparte y con costo por mensaje.
   */
  async pendientes(): Promise<AvisoPendiente[]> {
    const hoy = hoyLima();
    const desde = sumarDias(hoy, -this.DIAS_DESPUES);
    const hasta = sumarDias(hoy, this.DIAS_ANTES);

    const membresias = await this.prisma.membership.findMany({
      where: { estado: 'activa', fechaFin: { gte: desde, lte: hasta } },
      include: { member: true, plan: true },
      orderBy: { fechaFin: 'asc' },
    });

    // Un socio que ya renovo no debe aparecer por su membresia anterior.
    const vigentes = new Set(
      membresias.filter((m) => diasRestantes(m.fechaFin) > this.DIAS_ANTES).map((m) => m.memberId),
    );

    const avisos: AvisoPendiente[] = [];
    for (const m of membresias) {
      if (vigentes.has(m.memberId)) continue;
      if (!m.member.activo) continue;

      const dias = diasRestantes(m.fechaFin);
      const tipo: 'por_vencer' | 'vencido' = dias >= 0 ? 'por_vencer' : 'vencido';

      const reciente = await this.prisma.notification.findFirst({
        where: {
          memberId: m.memberId,
          tipo,
          enviadoAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
        },
      });

      const telefono = (m.member.telefono || '').replace(/\D/g, '');
      const mensaje = this.redactar(m.member.nombres, m.plan.nombre, dias);

      avisos.push({
        memberId: m.memberId,
        nombre: `${m.member.nombres} ${m.member.apellidos}`,
        telefono: m.member.telefono,
        plan: m.plan.nombre,
        vence: formatoFecha(m.fechaFin),
        diasRestantes: dias,
        tipo,
        mensaje,
        whatsapp: telefono
          ? `https://wa.me/51${telefono}?text=${encodeURIComponent(mensaje)}`
          : null,
        yaAvisado: !!reciente,
      });
    }

    // Primero los vencidos, que son los que se estan yendo.
    return avisos.sort((a, b) => a.diasRestantes - b.diasRestantes);
  }

  /** Mensaje corto, con el dato concreto y sin sonar a robot de cobranza. */
  private redactar(nombre: string, plan: string, dias: number): string {
    if (dias > 1) {
      return `Hola ${nombre}, te escribimos de ${this.GIMNASIO}. Tu plan ${plan} vence en ${dias} dias. Puedes renovar en recepcion cuando vengas a entrenar.`;
    }
    if (dias === 1) {
      return `Hola ${nombre}, te escribimos de ${this.GIMNASIO}. Tu plan ${plan} vence manana. Si renuevas antes, no pierdes ningun dia.`;
    }
    if (dias === 0) {
      return `Hola ${nombre}, te escribimos de ${this.GIMNASIO}. Hoy es el ultimo dia de tu plan ${plan}. Renueva en recepcion y sigues sin cortes.`;
    }
    return `Hola ${nombre}, te extranamos en ${this.GIMNASIO}. Tu plan ${plan} vencio hace ${Math.abs(dias)} dias. Cuando quieras retomar, te esperamos.`;
  }

  async marcarEnviado(memberId: string, tipo: string, mensaje: string) {
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio) throw new NotFoundException('Socio no encontrado');
    return this.prisma.notification.create({
      data: { memberId, tipo, canal: 'whatsapp', mensaje },
    });
  }

  historial(limite = 50) {
    return this.prisma.notification.findMany({
      orderBy: { enviadoAt: 'desc' },
      take: limite,
      include: { member: true },
    });
  }
}
