import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sumarDiasHabiles } from '../common/fechas';

/**
 * Libro de reclamaciones virtual (Codigo de Proteccion y Defensa del
 * Consumidor, Ley 29571).
 *
 * Es obligatorio para todo establecimiento abierto al publico, fisico o
 * virtual, y no tenerlo es la multa mas cara del paquete. Los campos siguen el
 * formato del anexo del reglamento.
 */
@Injectable()
export class ComplaintsService {
  /** El reglamento da 15 dias habiles improrrogables para responder. */
  private readonly DIAS_HABILES = 15;

  constructor(private prisma: PrismaService) {}

  private async siguienteCodigo(tx: any): Promise<string> {
    const anio = new Date().getUTCFullYear();
    const serie = await tx.serie.upsert({
      where: { tipo_serie: { tipo: 'reclamacion', serie: String(anio) } },
      update: { correlativo: { increment: 1 } },
      create: { tipo: 'reclamacion', serie: String(anio), correlativo: 1 },
    });
    return `LR-${anio}-${String(serie.correlativo).padStart(6, '0')}`;
  }

  async registrar(dto: any) {
    if (dto.esMenorDeEdad && !dto.apoderado?.trim()) {
      throw new BadRequestException(
        'Si el consumidor es menor de edad hay que indicar el nombre del padre o apoderado',
      );
    }

    const reclamo = await this.prisma.$transaction(async (tx) => {
      const codigo = await this.siguienteCodigo(tx);
      return tx.complaint.create({
        data: {
          codigo,
          tipo: dto.tipo,
          nombre: dto.nombre.trim(),
          tipoDoc: dto.tipoDoc,
          numDoc: dto.numDoc.trim(),
          telefono: dto.telefono?.trim() || null,
          email: dto.email.trim().toLowerCase(),
          direccion: dto.direccion?.trim() || null,
          esMenorDeEdad: !!dto.esMenorDeEdad,
          apoderado: dto.apoderado?.trim() || null,
          bienTipo: dto.bienTipo,
          bienDescripcion: dto.bienDescripcion.trim(),
          montoReclamado: dto.montoReclamado ?? null,
          detalle: dto.detalle.trim(),
          pedido: dto.pedido.trim(),
          plazoLimite: sumarDiasHabiles(new Date(), this.DIAS_HABILES),
          memberId: dto.memberId || null,
        },
      });
    });

    return {
      codigo: reclamo.codigo,
      plazoLimite: reclamo.plazoLimite,
      mensaje:
        'Tu registro quedo guardado. Tienes derecho a una respuesta en un plazo maximo de 15 dias habiles.',
    };
  }

  async listar(estado?: string) {
    const reclamos = await this.prisma.complaint.findMany({
      where: estado ? { estado } : undefined,
      orderBy: [{ estado: 'asc' }, { plazoLimite: 'asc' }],
      include: { member: true },
    });

    const hoy = Date.now();
    return reclamos.map((r) => ({
      ...r,
      diasParaResponder: Math.ceil((r.plazoLimite.getTime() - hoy) / (24 * 3600 * 1000)),
      vencido: r.estado === 'pendiente' && r.plazoLimite.getTime() < hoy,
    }));
  }

  async responder(id: string, respuesta: string, quien: string) {
    if (!respuesta?.trim() || respuesta.trim().length < 10) {
      throw new BadRequestException('La respuesta al consumidor no puede ser una linea vacia');
    }
    const reclamo = await this.prisma.complaint.findUnique({ where: { id } });
    if (!reclamo) throw new NotFoundException('Reclamo no encontrado');

    return this.prisma.complaint.update({
      where: { id },
      data: {
        estado: 'respondido',
        respuesta: respuesta.trim(),
        respondidoAt: new Date(),
        respondidoPor: quien,
      },
    });
  }

  /** Consulta publica por codigo: el consumidor sigue su reclamo sin cuenta. */
  async porCodigo(codigo: string) {
    const r = await this.prisma.complaint.findUnique({ where: { codigo: codigo.trim() } });
    if (!r) throw new NotFoundException('No encontramos ese codigo');
    return {
      codigo: r.codigo,
      tipo: r.tipo,
      estado: r.estado,
      createdAt: r.createdAt,
      plazoLimite: r.plazoLimite,
      respuesta: r.respuesta,
      respondidoAt: r.respondidoAt,
    };
  }
}
