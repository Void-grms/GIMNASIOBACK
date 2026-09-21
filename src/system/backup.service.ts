import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { diaLimaDe } from '../common/fechas';

/**
 * Respaldo de la base.
 *
 * Toda la operacion del gimnasio vive en un archivo en el disco de una PC de
 * recepcion. Un disco que muere o un ransomware se lleva socios, pagos y
 * comprobantes de una sola vez, asi que esto no es un lujo.
 */
@Injectable()
export class BackupService {
  private readonly log = new Logger('Respaldo');
  /** Cuantas copias se conservan antes de ir borrando las mas viejas. */
  private readonly CONSERVAR = 14;

  constructor(private prisma: PrismaService, private settings: SettingsService) {}

  private get carpeta() {
    return join(process.cwd(), 'backups');
  }

  private archivoBase(): string | null {
    const url = process.env.DATABASE_URL || '';
    if (!url.startsWith('file:')) return null;
    const ruta = url.replace('file:', '').split('?')[0];
    return ruta.startsWith('.') ? join(process.cwd(), 'prisma', ruta) : ruta;
  }

  /** 03:00 hora de Lima, cuando el gimnasio esta cerrado. */
  @Cron('0 8 * * *')
  async respaldoDiario() {
    try {
      await this.crear();
    } catch (e: any) {
      this.log.error(`Fallo el respaldo diario: ${e.message}`);
    }
  }

  async crear() {
    const origen = this.archivoBase();
    if (!origen) {
      return {
        ok: false,
        mensaje:
          'La base no es SQLite. Para PostgreSQL programa un pg_dump en el servidor; esto no lo reemplaza.',
      };
    }
    if (!existsSync(origen)) {
      return { ok: false, mensaje: 'Todavia no existe el archivo de la base' };
    }

    mkdirSync(this.carpeta, { recursive: true });
    const nombre = `gimnasio-${diaLimaDe(new Date())}-${Date.now()}.db`;
    const destino = join(this.carpeta, nombre);

    try {
      // VACUUM INTO deja una copia consistente aunque haya escrituras en curso.
      // Copiar el archivo a mano puede capturar una transaccion a medias.
      await this.prisma.$executeRawUnsafe(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
    } catch {
      copyFileSync(origen, destino);
    }

    this.rotar();
    await this.settings.actualizarRespaldo(nombre);
    this.log.log(`Respaldo creado: ${nombre}`);

    return { ok: true, archivo: nombre, tamano: statSync(destino).size };
  }

  private rotar() {
    const copias = readdirSync(this.carpeta)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ f, t: statSync(join(this.carpeta, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    for (const vieja of copias.slice(this.CONSERVAR)) {
      unlinkSync(join(this.carpeta, vieja.f));
    }
  }

  listar() {
    if (!existsSync(this.carpeta)) return [];
    return readdirSync(this.carpeta)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const s = statSync(join(this.carpeta, f));
        return { archivo: f, tamano: s.size, fecha: new Date(s.mtimeMs) };
      })
      .sort((a, b) => b.fecha.getTime() - a.fecha.getTime());
  }

  rutaDe(archivo: string): string | null {
    // Solo nombres planos: nada de subir por el arbol de directorios.
    if (!/^[\w.-]+\.db$/.test(archivo)) return null;
    const ruta = join(this.carpeta, archivo);
    return existsSync(ruta) ? ruta : null;
  }

  /** Cuantas horas hace del ultimo respaldo. Null si nunca hubo uno. */
  async estado() {
    const ajustes = await this.settings.obtener();
    const copias = this.listar();
    const ultimo = ajustes.ultimoRespaldoAt || copias[0]?.fecha || null;
    return {
      ultimo,
      archivo: ajustes.ultimoRespaldoArchivo || copias[0]?.archivo || null,
      copias: copias.length,
      horasDesde: ultimo ? Math.floor((Date.now() - new Date(ultimo).getTime()) / 3600000) : null,
      soportado: !!this.archivoBase(),
    };
  }
}
