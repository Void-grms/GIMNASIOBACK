import {
  Controller, ForbiddenException, Get, NotFoundException, Param, Post, StreamableFile, UseGuards,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { BackupService } from './backup.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { PrismaService } from '../prisma/prisma.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

@Controller('system')
@UseGuards(SoloStaffGuard)
export class SystemController {
  constructor(
    private backup: BackupService,
    private receipts: ReceiptsService,
    private prisma: PrismaService,
  ) {}

  private soloAdmin(sesion: Sesion) {
    if (sesion.rol !== 'admin') throw new ForbiddenException('Solo el administrador');
  }

  /** Lo que hay que mirar una vez por semana para saber si algo se rompio. */
  @Get('health')
  async salud() {
    const [respaldo, comprobantes, reclamos] = await Promise.all([
      this.backup.estado(),
      this.receipts.pendientes(),
      this.prisma.complaint.count({
        where: { estado: 'pendiente', plazoLimite: { lte: new Date(Date.now() + 3 * 86400000) } },
      }),
    ]);

    return {
      respaldo,
      comprobantesPendientes: comprobantes.length,
      reclamosPorVencer: reclamos,
      alertas: [
        respaldo.soportado && (respaldo.horasDesde === null || respaldo.horasDesde > 48)
          ? 'Hace mas de dos dias que no se respalda la base'
          : null,
        comprobantes.length > 0
          ? `${comprobantes.length} comprobante(s) sin confirmar ante SUNAT`
          : null,
        reclamos > 0 ? `${reclamos} reclamo(s) con el plazo por vencer` : null,
      ].filter(Boolean),
    };
  }

  @Get('backups')
  listar() {
    return this.backup.listar();
  }

  @Post('backups')
  crear(@SesionActual() sesion: Sesion) {
    this.soloAdmin(sesion);
    return this.backup.crear();
  }

  @Get('backups/:archivo')
  descargar(@Param('archivo') archivo: string, @SesionActual() sesion: Sesion) {
    this.soloAdmin(sesion);
    const ruta = this.backup.rutaDe(archivo);
    if (!ruta) throw new NotFoundException('Respaldo no encontrado');
    return new StreamableFile(createReadStream(ruta), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${archivo}"`,
    });
  }
}
