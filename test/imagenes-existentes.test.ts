/** Migracion aislada: archivos temporales, fotos ficticias y ninguna base real. */
import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { conFotoBloqueada, eliminarFotos, esFotoWebpActual } from '../src/common/imagenes';
import { PrismaService } from '../src/prisma/prisma.service';
import { ImagenesExistentesService } from '../src/system/imagenes-existentes.service';

type Fila = { id: string; fotoUrl: string | null; dni?: string | null };

function baseFicticia(socios: Fila[], productos: Fila[], antesDeCambiar?: (tipo: string, fila: Fila, opciones: any) => void) {
  const lotes: Array<{ tipo: string; take: number; cursor?: string }> = [];
  function delegado(tipo: string, filas: Fila[]) {
    return {
      async findMany(opciones: any) {
        lotes.push({ tipo, take: opciones.take, cursor: opciones.cursor?.id });
        const ordenadas = filas.filter(f => f.fotoUrl !== null).sort((a, b) => a.id.localeCompare(b.id));
        const inicio = opciones.cursor ? ordenadas.findIndex(f => f.id === opciones.cursor.id) + 1 : 0;
        return ordenadas.slice(inicio, inicio + opciones.take).map(f => ({ id: f.id }));
      },
      async findUnique(opciones: any) {
        const fila = filas.find(f => f.id === opciones.where.id);
        return fila ? { ...fila } : null;
      },
      async updateMany(opciones: any) {
        const fila = filas.find(f => f.id === opciones.where.id);
        if (!fila) return { count: 0 };
        antesDeCambiar?.(tipo, fila, opciones);
        if (fila.fotoUrl !== opciones.where.fotoUrl || fila.dni?.startsWith('ANON')) return { count: 0 };
        if (tipo === 'socios' && fila.dni === null) {
          assert.ok(opciones.where.OR.some((o: any) => o.dni === null), 'El CAS incluye socios sin DNI');
        }
        fila.fotoUrl = opciones.data.fotoUrl;
        return { count: 1 };
      },
    };
  }
  return { prisma: { member: delegado('socios', socios), product: delegado('productos', productos) }, lotes };
}

async function main() {
  const temporalBase = realpathSync.native(tmpdir());
  const temporal = realpathSync.native(mkdtempSync(join(temporalBase, 'gym-imagenes-migracion-')));
  const previos = { UPLOADS_DIR: process.env.UPLOADS_DIR, PRIVATE_DIR: process.env.PRIVATE_DIR };
  process.env.UPLOADS_DIR = join(temporal, 'uploads');
  process.env.PRIVATE_DIR = join(temporal, 'privado');
  const mensajes: string[] = [];
  let servicio: ImagenesExistentesService | undefined;
  function crear(prisma: unknown) {
    const instancia = new ImagenesExistentesService(prisma as PrismaService);
    (instancia as any).logger.log = (mensaje: string) => mensajes.push(mensaje);
    return instancia;
  }
  try {
    await mkdir(join(process.env.UPLOADS_DIR, 'socios'), { recursive: true });
    await mkdir(join(process.env.UPLOADS_DIR, 'productos'), { recursive: true });
    const png = await sharp(randomBytes(640 * 640 * 3), { raw: { width: 640, height: 640, channels: 3 } }).png().toBuffer();
    const minimo = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).webp().toBuffer();
    const socios: Fila[] = [
      { id: 'aaa0', dni: null, fotoUrl: '/uploads/socios/aaa0.png?v=1' },
      { id: 'anon0', dni: 'ANON-ficticio', fotoUrl: '/uploads/socios/anon0.png' },
      { id: 'corrupto0', dni: null, fotoUrl: '/uploads/socios/corrupto0.png' },
      { id: 'externo0', dni: null, fotoUrl: 'https://ejemplo.invalid/foto.png' },
      { id: 'falta0', dni: null, fotoUrl: '/uploads/socios/falta0.jpg' },
      { id: 'grande0', dni: null, fotoUrl: '/uploads/socios/grande0.png' },
      { id: 'mutacion0', dni: null, fotoUrl: '/uploads/socios/mutacion0.png' },
      { id: 'privado0', dni: null, fotoUrl: '/privado/yape/captura.png' },
      { id: 'traversal0', dni: null, fotoUrl: '/uploads/socios/../privado/traversal0.png' },
    ];
    for (let i = 0; i < 102; i++) socios.push({ id: `zz${String(i).padStart(3, '0')}`, fotoUrl: 'https://ejemplo.invalid/foto.png' });
    const productos: Fila[] = [
      { id: 'producto0', fotoUrl: '/uploads/productos/producto0.png' },
      { id: 'minimo0', fotoUrl: '/uploads/productos/minimo0.webp' },
    ];
    for (const id of ['aaa0', 'anon0', 'mutacion0']) await writeFile(join(process.env.UPLOADS_DIR, 'socios', `${id}.png`), png);
    await writeFile(join(process.env.UPLOADS_DIR, 'socios', 'corrupto0.png'), 'esto no es una imagen');
    await writeFile(join(process.env.UPLOADS_DIR, 'socios', 'grande0.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await writeFile(join(process.env.UPLOADS_DIR, 'productos', 'producto0.png'), png);
    await writeFile(join(process.env.UPLOADS_DIR, 'productos', 'minimo0.webp'), minimo);
    const base = baseFicticia(socios, productos, (_tipo, fila) => {
      if (fila.id === 'mutacion0') fila.fotoUrl = 'https://ejemplo.invalid/foto-nueva.webp';
    });
    servicio = crear(base.prisma);
    const primera = servicio.ejecutar();
    assert.equal(servicio.ejecutar(), primera, 'Dos ejecuciones simultaneas comparten la pasada');
    const resumen = await primera;
    assert.equal(resumen.convertidas, 2, JSON.stringify(resumen));
    assert.equal(resumen.fallidas, 2);
    assert.ok(resumen.bytesAhorrados > 0);
    assert.equal(resumen.bytesAhorrados, resumen.bytesAntes - resumen.bytesDespues);
    assert.ok(base.lotes.some(l => l.tipo === 'socios' && l.cursor), 'Pagina despues de las primeras 100 filas');
    assert.ok(base.lotes.every(l => l.take === 100));
    const miembro = socios.find(f => f.id === 'aaa0')!;
    assert.ok(esFotoWebpActual('socios', miembro.id, miembro.fotoUrl!));
    assert.equal((await stat(join(process.env.UPLOADS_DIR, 'socios', 'aaa0.png'))).size, png.length, 'Conserva el original para rollback');
    const manifiesto = JSON.parse(await readFile(join(process.env.PRIVATE_DIR, 'imagenes-webp', 'socios', 'aaa0.json'), 'utf8'));
    assert.equal(manifiesto.version, 1);
    assert.equal(manifiesto.archivos[0].antes, '/uploads/socios/aaa0.png?v=1');
    assert.equal(manifiesto.archivos[0].despues, miembro.fotoUrl);
    assert.match(manifiesto.archivos[0].sha256Antes, /^[a-f0-9]{64}$/);
    assert.match(manifiesto.archivos[0].sha256Despues, /^[a-f0-9]{64}$/);
    assert.equal(socios.find(f => f.id === 'anon0')!.fotoUrl, '/uploads/socios/anon0.png');
    assert.equal(socios.find(f => f.id === 'mutacion0')!.fotoUrl, 'https://ejemplo.invalid/foto-nueva.webp', 'No pisa la foto reemplazada durante el CAS');
    assert.ok(!(await readdir(join(process.env.UPLOADS_DIR, 'socios'))).some(nombre => nombre.startsWith('mutacion0-webp-v1-')), 'El CAS fallido no deja una foto derivada huerfana');
    await assert.rejects(stat(join(process.env.PRIVATE_DIR, 'imagenes-webp', 'socios', 'mutacion0.json')), (e: any) => e.code === 'ENOENT');
    assert.deepEqual((await readdir(join(process.env.UPLOADS_DIR, 'productos'))).filter(nombre => nombre.startsWith('minimo0')), ['minimo0.webp'], 'Una conversion sin ahorro no deja otra copia');
    const urlTratada = miembro.fotoUrl;
    const segunda = await servicio.ejecutar();
    assert.equal(segunda.convertidas, 0);
    assert.equal(miembro.fotoUrl, urlTratada);
    assert.equal(JSON.parse(await readFile(join(process.env.PRIVATE_DIR, 'imagenes-webp', 'socios', 'aaa0.json'), 'utf8')).archivos.length, 1);
    for (const mensaje of mensajes) {
      assert.ok(!mensaje.includes('aaa0') && !mensaje.includes('/uploads') && !mensaje.includes('ejemplo.invalid'), 'Los logs no incluyen identificadores o rutas');
    }

    // El cambio posterior al listado y anterior a la toma del lock se respeta.
    await writeFile(join(process.env.UPLOADS_DIR, 'socios', 'retirado0.png'), png);
    const retirado: Fila = { id: 'retirado0', dni: null, fotoUrl: '/uploads/socios/retirado0.png' };
    const baseRetirado = baseFicticia([retirado], []);
    const otro = crear(baseRetirado.prisma);
    let liberar!: () => void;
    let lockTomado!: () => void;
    const tomado = new Promise<void>(r => { lockTomado = r; });
    const bloqueo = conFotoBloqueada('socios', retirado.id, async () => {
      lockTomado();
      await new Promise<void>(r => { liberar = r; });
      retirado.fotoUrl = null;
    });
    await tomado;
    const migracion = otro.ejecutar();
    await new Promise<void>(r => setImmediate(r));
    liberar();
    await bloqueo;
    assert.equal((await migracion).convertidas, 0);
    assert.equal(retirado.fotoUrl, null);
    await otro.beforeApplicationShutdown();

    // Un proceso que anonimize durante el CAS no conserva el derivado ni manifiesto.
    await writeFile(join(process.env.UPLOADS_DIR, 'socios', 'anonrace0.png'), png);
    const anonimizado: Fila = { id: 'anonrace0', dni: null, fotoUrl: '/uploads/socios/anonrace0.png' };
    const baseAnonimizado = baseFicticia([anonimizado], [], (_tipo, fila) => {
      fila.dni = 'ANON-durante-cas';
      fila.fotoUrl = null;
    });
    const migradorAnonimizado = crear(baseAnonimizado.prisma);
    assert.equal((await migradorAnonimizado.ejecutar()).convertidas, 0);
    assert.ok(!(await readdir(join(process.env.UPLOADS_DIR, 'socios'))).some(nombre => nombre.startsWith('anonrace0-webp-v1-')));
    await assert.rejects(stat(join(process.env.PRIVATE_DIR, 'imagenes-webp', 'socios', 'anonrace0.json')), (e: any) => e.code === 'ENOENT');
    await migradorAnonimizado.beforeApplicationShutdown();

    // Un directorio privado mal configurado nunca publica el manifiesto.
    const privadaCorrecta = process.env.PRIVATE_DIR;
    process.env.PRIVATE_DIR = join(process.env.UPLOADS_DIR, 'privado-mal-configurado');
    const malConfigurado: Fila = { id: 'config0', dni: null, fotoUrl: '/uploads/socios/config0.png' };
    await writeFile(join(process.env.UPLOADS_DIR, 'socios', 'config0.png'), png);
    const migradorConfiguracion = crear(baseFicticia([malConfigurado], []).prisma);
    const resultadoConfiguracion = await migradorConfiguracion.ejecutar();
    assert.equal(resultadoConfiguracion.convertidas, 0);
    assert.equal(resultadoConfiguracion.fallidas, 1);
    assert.equal(malConfigurado.fotoUrl, '/uploads/socios/config0.png');
    await assert.rejects(stat(join(process.env.PRIVATE_DIR, 'imagenes-webp')), (e: any) => e.code === 'ENOENT');
    await migradorConfiguracion.beforeApplicationShutdown();
    process.env.PRIVATE_DIR = privadaCorrecta;

    // La supresion borra tanto el resultado como el original y su manifiesto.
    await conFotoBloqueada('socios', 'aaa0', () => eliminarFotos('socios', 'aaa0'));
    await assert.rejects(stat(join(process.env.UPLOADS_DIR, 'socios', 'aaa0.png')), (e: any) => e.code === 'ENOENT');
    await assert.rejects(stat(join(process.env.PRIVATE_DIR, 'imagenes-webp', 'socios', 'aaa0.json')), (e: any) => e.code === 'ENOENT');
    console.log('OK: migracion WebP aislada, repeticion, limites, privacidad, CAS, paginacion, lock y supresion.');
  } finally {
    await servicio?.beforeApplicationShutdown();
    for (const [nombre, valor] of Object.entries(previos)) {
      if (valor === undefined) delete process.env[nombre]; else process.env[nombre] = valor;
    }
    const destino = resolve(temporal);
    assert.ok(destino.startsWith(resolve(temporalBase) + sep) && destino !== resolve(temporalBase));
    rmSync(destino, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
