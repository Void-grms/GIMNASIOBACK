import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipsService } from '../memberships/memberships.service';
import { MembersService } from '../members/members.service';
import { carpetaPrivada, guardarImagen } from '../common/archivos';

/**
 * Renovacion desde el portal: el socio elige plan, paga por Yape y sube la
 * captura. Nada cambia hasta que recepcion revisa la captura contra su Yape y
 * aprueba; recien ahi se cobra como una venta normal de membresia, con las
 * mismas reglas de fechas, dias de gracia y comprobante.
 */
@Injectable()
export class RenewalsService {
  constructor(
    private prisma: PrismaService,
    private memberships: MembershipsService,
    private members: MembersService,
  ) {}

  /** Planes que el socio puede renovar solo. El universitario exige carne vigente. */
  async planes(memberId: string) {
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    const planes = await this.prisma.plan.findMany({
      where: { activo: true, duracionDias: { gt: 1 } },
      orderBy: [{ orden: 'asc' }, { precio: 'asc' }],
    });
    const ajustes = await this.prisma.settings.findUnique({ where: { id: 'default' } });
    return {
      yapeNumero: ajustes?.yapeNumero || '',
      yapeTitular: ajustes?.yapeTitular || '',
      terminosTexto: ajustes?.terminosTexto || '',
      planes: planes
        .filter((p) => !p.requiereEvidencia || socio?.esUniversitario)
        .map((p) => ({
          id: p.id,
          nombre: p.nombre,
          precio: p.precio,
          duracionDias: p.duracionDias,
          descripcion: p.descripcion,
        })),
    };
  }

  async solicitar(
    memberId: string,
    dto: { planId: string; imagen: string; operacion?: string; aceptaTerminos: boolean },
    ip?: string,
  ) {
    if (!dto.aceptaTerminos) {
      throw new BadRequestException('Tienes que aceptar las condiciones de la membresia');
    }
    const ajustes = await this.prisma.settings.findUnique({ where: { id: 'default' } });
    if (!ajustes?.yapeNumero) {
      throw new BadRequestException('El gimnasio aun no activo el pago por Yape. Renueva en recepcion.');
    }
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio || !socio.activo) throw new BadRequestException('Tu cuenta no esta activa');

    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan || !plan.activo || plan.duracionDias <= 1) {
      throw new BadRequestException('Ese plan no se puede renovar desde el portal');
    }
    if (plan.requiereEvidencia && !socio.esUniversitario) {
      throw new BadRequestException('Ese plan exige carne universitario: acercate a recepcion.');
    }

    const abierta = await this.prisma.renewalRequest.findFirst({
      where: { memberId, estado: { in: ['pendiente', 'revisando'] } },
    });
    if (abierta) {
      throw new BadRequestException('Ya tienes una renovacion en revision. Te avisamos al aprobarla.');
    }

    const solicitud = await this.prisma.renewalRequest.create({
      data: {
        memberId,
        planId: plan.id,
        monto: plan.precio,
        operacion: dto.operacion?.trim() || null,
        comprobante: 'pendiente',
      },
    });
    try {
      const ext = guardarImagen(dto.imagen, join(carpetaPrivada(), 'yape'), solicitud.id, 3 * 1024 * 1024);
      await this.prisma.renewalRequest.update({
        where: { id: solicitud.id },
        data: { comprobante: `yape/${solicitud.id}.${ext}` },
      });
    } catch (e) {
      await this.prisma.renewalRequest.delete({ where: { id: solicitud.id } });
      throw e;
    }
    await this.members.registrarConsentimiento(memberId, 'terminos', 'portal', ip);
    return this.miEstado(memberId);
  }

  /** Lo que el portal muestra: la ultima solicitud y en que va. */
  async miEstado(memberId: string) {
    const ultima = await this.prisma.renewalRequest.findFirst({
      where: { memberId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    if (!ultima) return null;
    return {
      id: ultima.id,
      estado: ultima.estado === 'revisando' ? 'pendiente' : ultima.estado,
      plan: ultima.plan.nombre,
      monto: ultima.monto,
      motivoRechazo: ultima.motivoRechazo,
      creado: ultima.createdAt,
      revisado: ultima.revisadoAt,
    };
  }

  // ------------------------------------------------------------- recepcion

  async pendientes() {
    const lista = await this.prisma.renewalRequest.findMany({
      where: { estado: 'pendiente' },
      orderBy: { createdAt: 'asc' },
      include: { plan: true, member: true },
    });
    return lista.map((r) => ({
      id: r.id,
      creado: r.createdAt,
      monto: r.monto,
      operacion: r.operacion,
      plan: r.plan.nombre,
      socio: {
        id: r.member.id,
        nombreCompleto: `${r.member.nombres} ${r.member.apellidos}`,
        dni: r.member.dni,
      },
    }));
  }

  /** Ruta absoluta de la captura, para que el controlador la envie. */
  async archivoComprobante(id: string) {
    const r = await this.prisma.renewalRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Solicitud no encontrada');
    const ruta = join(carpetaPrivada(), r.comprobante);
    if (!existsSync(ruta)) throw new NotFoundException('La captura ya no esta en el servidor');
    return ruta;
  }

  /**
   * Aprobar = cobrar. Se toma la solicitud con un cambio de estado condicional
   * para que dos recepcionistas no generen dos membresias por el mismo Yape.
   */
  async aprobar(id: string, cajeroId: string) {
    const tomada = await this.prisma.renewalRequest.updateMany({
      where: { id, estado: 'pendiente' },
      data: { estado: 'revisando' },
    });
    if (tomada.count === 0) throw new BadRequestException('Esa solicitud ya fue revisada');
    const r = await this.prisma.renewalRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Solicitud no encontrada');

    let membresia: any;
    try {
      membresia = await this.memberships.vender({
        memberId: r.memberId,
        planId: r.planId,
        metodo: r.metodo,
        monto: r.monto,
        aceptaTerminos: true,
        cajeroId,
        observacion: `Renovacion desde el portal${r.operacion ? `, Yape op. ${r.operacion}` : ''}`,
      });
    } catch (e) {
      await this.prisma.renewalRequest.update({ where: { id }, data: { estado: 'pendiente' } });
      throw e;
    }
    await this.prisma.renewalRequest.update({
      where: { id },
      data: {
        estado: 'aprobada',
        membershipId: membresia.id,
        revisadoPor: cajeroId,
        revisadoAt: new Date(),
      },
    });
    return {
      ok: true,
      inicio: membresia.inicio,
      vence: membresia.vence,
      errorComprobante: membresia.errorComprobante,
    };
  }

  async rechazar(id: string, motivo: string, cajeroId: string) {
    const limpio = (motivo || '').trim();
    if (limpio.length < 3) throw new BadRequestException('Escribe el motivo para que el socio lo vea');
    const r = await this.prisma.renewalRequest.updateMany({
      where: { id, estado: 'pendiente' },
      data: { estado: 'rechazada', motivoRechazo: limpio, revisadoPor: cajeroId, revisadoAt: new Date() },
    });
    if (r.count === 0) throw new BadRequestException('Esa solicitud ya fue revisada');
    return { ok: true };
  }
}
