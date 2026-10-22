import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { carpetaArchivos, carpetaPrivada } from '../common/archivos';
import {
  conFotoBloqueada, esFotoWebpActual, guardarFotoConvertida, rutaFotoLocal, TipoFoto,
} from '../common/imagenes';
import { PrismaService } from '../prisma/prisma.service';

export interface ResumenImagenesExistentes {
  revisadas: number;
  convertidas: number;
  omitidas: number;
  fallidas: number;
  bytesAntes: number;
  bytesDespues: number;
  bytesAhorrados: number;
}

interface EntradaManifiesto {
  antes: string;
  despues: string;
  bytesAntes: number;
  bytesDespues: number;
  sha256Antes: string;
  sha256Despues: string;
  registradoEl: string;
}

/** Se ejecuta en el servicio activo, donde Railway ya monto el volumen. */
@Injectable()
export class ImagenesExistentesService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ImagenesExistentesService.name);
  private temporizador?: ReturnType<typeof setTimeout>;
  private enCurso?: Promise<ResumenImagenesExistentes>;
  private cerrando = false;
  private readonly maxBytes = 10 * 1024 * 1024;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    const opcion = process.env.IMAGENES_MIGRAR_AL_INICIAR;
    if (opcion === 'false' || (process.env.NODE_ENV !== 'production' && opcion !== 'true')) return;
    this.temporizador = setTimeout(() => {
      this.temporizador = undefined;
      void this.ejecutar().catch(() => {
        this.logger.warn('No se pudo terminar la optimizacion de imagenes. Se reintentara en el proximo inicio.');
      });
    }, 3000);
    this.temporizador.unref();
  }

  async beforeApplicationShutdown() {
    this.cerrando = true;
    if (this.temporizador) clearTimeout(this.temporizador);
    // Una foto que ya comenzo termina antes de desconectar el proceso.
    await this.enCurso?.catch(() => undefined);
  }

  /** Tambien permite ejecutar y comprobar una pasada desde una herramienta local. */
  ejecutar(): Promise<ResumenImagenesExistentes> {
    if (this.enCurso) return this.enCurso;
    this.enCurso = this.procesar().finally(() => { this.enCurso = undefined; });
    return this.enCurso;
  }

  private async procesar(): Promise<ResumenImagenesExistentes> {
    const resumen: ResumenImagenesExistentes = {
      revisadas: 0, convertidas: 0, omitidas: 0, fallidas: 0,
      bytesAntes: 0, bytesDespues: 0, bytesAhorrados: 0,
    };
    for (const tipo of ['socios', 'productos'] as const) {
      let cursor: string | undefined;
      while (!this.cerrando) {
        const opciones = {
          where: { fotoUrl: { not: null } }, select: { id: true },
          orderBy: { id: 'asc' as const }, take: 100,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        };
        const lote = tipo === 'socios'
          ? await this.prisma.member.findMany(opciones)
          : await this.prisma.product.findMany(opciones);
        if (!lote.length) break;
        for (const fila of lote) {
          if (this.cerrando) break;
          resumen.revisadas++;
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(fila.id)) {
            resumen.omitidas++;
            continue;
          }
          try {
            await conFotoBloqueada(tipo, fila.id, () => this.convertir(tipo, fila.id, resumen));
          } catch {
            // Un archivo dañado o ausente no impide procesar las otras fotos.
            resumen.fallidas++;
          }
        }
        cursor = lote[lote.length - 1].id;
        if (lote.length < 100) break;
      }
    }
    resumen.bytesAhorrados = resumen.bytesAntes - resumen.bytesDespues;
    this.logger.log(
      `Optimizacion de imagenes: revisadas=${resumen.revisadas}, convertidas=${resumen.convertidas}, ` +
      `omitidas=${resumen.omitidas}, fallidas=${resumen.fallidas}, ` +
      `bytesAntes=${resumen.bytesAntes}, bytesDespues=${resumen.bytesDespues}, ` +
      `bytesAhorrados=${resumen.bytesAhorrados}`,
    );
    return resumen;
  }

  private async convertir(tipo: TipoFoto, id: string, resumen: ResumenImagenesExistentes) {
    // Reconsultar dentro del mismo lock que la subida y la supresion evita
    // revivir una foto que el socio reemplazo o solicito eliminar.
    const fila = tipo === 'socios'
      ? await this.prisma.member.findUnique({ where: { id }, select: { fotoUrl: true, dni: true } })
      : await this.prisma.product.findUnique({ where: { id }, select: { fotoUrl: true } });
    if (!fila?.fotoUrl || ('dni' in fila && typeof fila.dni === 'string' && fila.dni.startsWith('ANON')) || esFotoWebpActual(tipo, id, fila.fotoUrl)) {
      resumen.omitidas++;
      return;
    }
    const antes = fila.fotoUrl;
    const ruta = await rutaFotoLocal(tipo, id, antes);
    if (!ruta) {
      resumen.omitidas++;
      return;
    }
    const original = await this.leerAcotado(ruta);
    const convertida = await guardarFotoConvertida(tipo, id, original);
    try {
      if (convertida.bytes >= original.length) {
        await this.descartarNoReferenciada(tipo, id, convertida);
        resumen.omitidas++;
        return;
      }
      // Guardar el manifiesto antes del CAS mantiene la ruta de recuperacion
      // incluso ante un reinicio entre la escritura y la actualizacion.
      // Para revertir, comprobar que la fila siga apuntando a "despues".
      await this.registrarManifiesto(tipo, id, {
        antes, despues: convertida.fotoUrl,
        bytesAntes: original.length, bytesDespues: convertida.bytes,
        sha256Antes: createHash('sha256').update(original).digest('hex'),
        sha256Despues: createHash('sha256').update(await this.leerAcotado(convertida.ruta)).digest('hex'),
        registradoEl: new Date().toISOString(),
      });
      const cambio = tipo === 'socios'
        ? await this.prisma.member.updateMany({ where: { id, fotoUrl: antes, OR: [{ dni: null }, { NOT: { dni: { startsWith: 'ANON' } } }] }, data: { fotoUrl: convertida.fotoUrl } })
        : await this.prisma.product.updateMany({ where: { id, fotoUrl: antes }, data: { fotoUrl: convertida.fotoUrl } });
      if (!cambio.count) {
        await this.descartarNoReferenciada(tipo, id, convertida);
        resumen.omitidas++;
        return;
      }
    } catch (error) {
      await this.descartarNoReferenciada(tipo, id, convertida).catch(() => undefined);
      throw error;
    }
    resumen.convertidas++;
    resumen.bytesAntes += original.length;
    resumen.bytesDespues += convertida.bytes;
  }

  private async descartarNoReferenciada(tipo: TipoFoto, id: string, convertida: { fotoUrl: string; ruta: string }) {
    const actual = tipo === 'socios'
      ? await this.prisma.member.findUnique({ where: { id }, select: { fotoUrl: true, dni: true } })
      : await this.prisma.product.findUnique({ where: { id }, select: { fotoUrl: true } });
    if (actual?.fotoUrl === convertida.fotoUrl) return;
    await unlink(convertida.ruta).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    const ruta = this.rutaManifiesto(tipo, id);
    let previo: any;
    try { previo = JSON.parse(await readFile(ruta, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (previo.version !== 1 || previo.tipo !== tipo || previo.id !== id || !Array.isArray(previo.archivos)) throw new Error('Manifiesto invalido');
    const anonimo = actual && 'dni' in actual && typeof actual.dni === 'string' && actual.dni.startsWith('ANON');
    previo.archivos = anonimo ? [] : previo.archivos.filter((a: EntradaManifiesto) => a.despues !== convertida.fotoUrl);
    if (!previo.archivos.length) await unlink(ruta);
    else await this.escribirManifiesto(ruta, previo);
  }

  private async leerAcotado(ruta: string): Promise<Buffer> {
    const archivo = await open(ruta, 'r');
    try {
      const stat = await archivo.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.maxBytes) throw new Error('Archivo fuera de limites');
      // Se reserva como maximo el limite mas un byte; un archivo que crezca
      // entre stat y read no puede ocasionar una lectura sin limite.
      const buffer = Buffer.alloc(stat.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await archivo.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total !== stat.size) throw new Error('El archivo cambio durante la lectura');
      return buffer.subarray(0, total);
    } finally {
      await archivo.close();
    }
  }

  private rutaManifiesto(tipo: TipoFoto, id: string) {
    const publica = resolve(carpetaArchivos());
    const privada = resolve(carpetaPrivada());
    const diferencia = relative(publica, privada);
    if (!diferencia || (diferencia !== '..' && !diferencia.startsWith(`..${sep}`) && !isAbsolute(diferencia))) {
      // Evitar servir el registro de recuperacion desde /uploads si el
      // directorio privado fue configurado accidentalmente dentro del publico.
      throw new Error('El directorio privado debe estar fuera del publico');
    }
    return join(privada, 'imagenes-webp', tipo, `${id}.json`);
  }

  private async registrarManifiesto(tipo: TipoFoto, id: string, entrada: EntradaManifiesto) {
    const carpeta = join(carpetaPrivada(), 'imagenes-webp', tipo);
    const ruta = this.rutaManifiesto(tipo, id);
    await mkdir(carpeta, { recursive: true, mode: 0o700 });
    let archivos: EntradaManifiesto[] = [];
    try {
      const previo = JSON.parse(await readFile(ruta, 'utf8'));
      if (previo.version !== 1 || previo.tipo !== tipo || previo.id !== id || !Array.isArray(previo.archivos)) {
        throw new Error('Manifiesto invalido');
      }
      archivos = previo.archivos;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!archivos.some(a => a.antes === entrada.antes && a.despues === entrada.despues)) archivos.push(entrada);
    await this.escribirManifiesto(ruta, { version: 1, tipo, id, archivos });
  }

  private async escribirManifiesto(ruta: string, contenido: unknown) {
    const temporal = `${ruta}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporal, JSON.stringify(contenido, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporal, ruta);
    } finally {
      await unlink(temporal).catch(() => undefined);
    }
  }
}
