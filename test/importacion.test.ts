/** Pruebas anonimas de migracion: no leen el ERP real ni abren una base. */
import assert from 'assert';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as bcrypt from 'bcryptjs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { aplicarImportacion, celularERP, encabezadosClientes, encabezadosHistorial, fechaERP, importarArchivo, ImportacionBloqueada, leerLibroERP, prepararImportacion, textoCelda } from '../scripts/importar-erp';

function libro() {
  const wb = new ExcelJS.Workbook();
  const c = wb.addWorksheet('Clientes');
  const h = wb.addWorksheet('Historial');
  c.getRow(6).values = encabezadosClientes;
  h.getRow(6).values = encabezadosHistorial;
  c.getRow(7).values = ['001277', 'SOCIO ANONIMO', 'PRUEBA', '01234567', '+51 987 654 321', '', '', '', '', '', '', '', 'cliente:1', 'unidad', 'sede', ''];
  c.getRow(8).values = ['0002', 'OTRO SOCIO', 'PRUEBA', 'NO-VERIFICADO', 'telefono invalido', '', '', '', '', '', '', '', 'cliente:2', 'unidad', 'sede', ''];
  h.getRow(7).values = [1, '001277', 'SOCIO ANONIMO PRUEBA', 'Activo', 'PLAN DEMO', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'), 89.9, '', '', '', 'MEM-1', 'his:1', '', 1, 'unidad', 'sede', ''];
  h.getRow(8).values = [2, '0002', 'OTRO SOCIO PRUEBA', 'Vencido', 'PLAN DEMO', new Date('2025-10-01T00:00:00Z'), new Date('2025-10-31T00:00:00Z'), 89.9, '', '', '', '', 'his:2', '', 2, 'unidad', 'sede', ''];
  return wb;
}

type Estado = { miembros: any[]; planes: any[]; membresias: any[] };
function coincide(registro: any, where: any): boolean {
  if (where.OR) return where.OR.some((item: any) => coincide(registro, item));
  return Object.entries(where).every(([columna, filtro]: [string, any]) => filtro.in ? filtro.in.includes(registro[columna]) : registro[columna] === filtro);
}
function modelos(estado: Estado) {
  const modelo = (lista: any[], prefijo: string) => ({
    findMany: async ({ where }: any) => lista.filter(registro => coincide(registro, where)),
    create: async ({ data }: any) => { const nuevo = { id: `${prefijo}${lista.length + 1}`, ...structuredClone(data) }; lista.push(nuevo); return nuevo; },
  });
  return { member: modelo(estado.miembros, 's'), plan: modelo(estado.planes, 'p'), membership: modelo(estado.membresias, 'm') };
}
function baseMemoria(estado: Estado = { miembros: [], planes: [], membresias: [] }) {
  return {
    estado,
    ...modelos(estado),
    $transaction: async (cb: (tx: any) => Promise<void>) => {
      const draft = structuredClone(estado);
      await cb(modelos(draft));
      estado.miembros.splice(0, estado.miembros.length, ...draft.miembros);
      estado.planes.splice(0, estado.planes.length, ...draft.planes);
      estado.membresias.splice(0, estado.membresias.length, ...draft.membresias);
    },
    $disconnect: async () => undefined,
  };
}

let comprobaciones = 0;
async function prueba(nombre: string, fn: () => void | Promise<void>) {
  await fn(); comprobaciones++; console.log(`ok ${nombre}`);
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gimnasio-import-test-'));
  try {
    await prueba('codigos y DNI conservan ceros; documento invalido queda nulo', () => {
      const wb = libro();
      wb.getWorksheet('Clientes').getCell('A8').value = 2;
      wb.getWorksheet('Clientes').getCell('A8').numFmt = '0000';
      const prep = prepararImportacion(wb, { crearPlanesHistoricos: true });
      assert.equal(prep.informe.resumen.errores, 0);
      assert.equal(prep.socios[0].codigoERP, '001277');
      assert.equal(prep.socios[0].dni, '01234567');
      assert.equal(prep.socios[1].codigoERP, '0002');
      assert.equal(prep.socios[1].dni, null);
      assert.equal(prep.socios[1].documentoERP, 'NO-VERIFICADO');
      assert.equal(prep.socios[1].telefono, null);
      assert(!JSON.stringify(prep.informe).includes('SOCIO ANONIMO'));
      assert(!JSON.stringify(prep.informe).includes('01234567'));
      assert(!JSON.stringify(prep.informe).includes('987654321'));
    });
    await prueba('codigos o DNI duplicados bloquean toda aplicacion', async () => {
      const wb = libro();
      wb.getWorksheet('Clientes').getCell('A8').value = '001277';
      const prep = prepararImportacion(wb, { crearPlanesHistoricos: true });
      const db = baseMemoria();
      await assert.rejects(() => aplicarImportacion(prep, db), ImportacionBloqueada);
      assert.equal(db.estado.miembros.length, 0);
      wb.getWorksheet('Clientes').getCell('A8').value = '0002';
      wb.getWorksheet('Clientes').getCell('D8').value = '01234567';
      assert(prepararImportacion(wb, { crearPlanesHistoricos: true }).informe.resumen.errores > 0);
    });
    await prueba('fechas imposibles, ausentes y traspasos no crean acceso', () => {
      assert.equal(fechaERP('31/02/2026'), null);
      assert.equal(fechaERP('texto de instrucciones'), null);
      assert.equal(fechaERP('2026-10-01T00:00:00.000Z').toISOString(), '2026-10-01T00:00:00.000Z');
      const wb = libro();
      wb.getWorksheet('Historial').getCell('G7').value = new Date('2026-09-30T00:00:00Z');
      wb.getWorksheet('Historial').getCell('D8').value = 'Traspaso';
      const prep = prepararImportacion(wb, { crearPlanesHistoricos: true });
      assert.equal(prep.membresias.length, 0);
      assert.equal(prep.informe.resumen.membresiasOmitidas, 2);
      wb.getWorksheet('Historial').getCell('G7').value = null;
      assert.equal(prepararImportacion(wb, { crearPlanesHistoricos: true }).membresias.length, 0);
    });
    await prueba('estados, fechas inclusivas, precio y referencias originales se conservan', () => {
      const prep = prepararImportacion(libro(), { crearPlanesHistoricos: true });
      assert.equal(prep.membresias[0].estado, 'activa');
      assert.equal(prep.membresias[1].estado, 'vencida');
      assert.equal(prep.membresias[0].fechaFin.toISOString(), '2026-10-31T00:00:00.000Z');
      assert.equal(prep.membresias[0].precioPagado, 89.9);
      assert.equal(prep.membresias[1].codigoERP, 'forcesgym:ref:his:2');
      assert.equal(prep.planes[0].duracionDias, 31);
      assert.equal(prep.planes.length, 1);
    });
    await prueba('identificador de membresia repetido es un conflicto', () => {
      const wb = libro();
      wb.getWorksheet('Historial').getCell('L8').value = 'MEM-1';
      assert(prepararImportacion(wb, { crearPlanesHistoricos: true }).informe.resumen.errores > 0);
    });
    await prueba('simulacion lee XLSX sin crear ni consultar cliente de base', async () => {
      const archivo = path.join(tmp, 'anonimo.xlsx');
      await libro().xlsx.writeFile(archivo);
      let conexiones = 0;
      const result = await importarArchivo(archivo, { crearPlanesHistoricos: true, crearCliente: async () => { conexiones++; throw new Error('No debe conectarse'); } });
      assert.equal(conexiones, 0);
      assert.equal(result.modo, 'simulacion');
      assert.equal(result.fuenteSHA256.length, 64);
      assert.equal(result.resumen.membresiasPreparadas, 2);
    });
    await prueba('XML con prefijos, ISO t=d y relaciones absolutas mantiene datos/fechas', async () => {
      const wb = libro();
      wb.getWorksheet('Clientes').getCell('B7').value = 'ANONIMO & <PRUEBA>';
      wb.getWorksheet('Clientes').addTable({ name: 'ClientesPrueba', ref: 'A6', headerRow: true, columns: encabezadosClientes.map(name => ({ name })), rows: [Array.from({ length: 16 }, (_, i) => wb.getWorksheet('Clientes').getCell(7, i + 1).value), Array.from({ length: 16 }, (_, i) => wb.getWorksheet('Clientes').getCell(8, i + 1).value)] });
      const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer() as any);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        if (entry.name.endsWith('.rels')) {
          const xml = await entry.async('string');
          const base = entry.name === '_rels/.rels' ? '' : path.posix.dirname(entry.name.replace('/_rels/', '/').replace(/\.rels$/, ''));
          zip.file(entry.name, xml.replace(/Target="([^"#]+)"/g, (full, target) => /^https?:/.test(target) ? full : `Target="/${path.posix.normalize(path.posix.join(base, target))}"`));
          continue;
        }
        if (!entry.name.endsWith('.xml')) continue;
        let xml = await entry.async('string');
        if (!xml.includes('http://schemas.openxmlformats.org/spreadsheetml/2006/main')) continue;
        if (entry.name === 'xl/worksheets/sheet2.xml') {
          xml = xml.replace(/<c r="F7"[^>]*>.*?<\/c>/, '<c r="F7" t="d"><v>2026-10-01T00:00:00.000Z</v></c>');
          xml = xml.replace(/<c r="G7"[^>]*>.*?<\/c>/, '<c r="G7" t="d"><v>2026-10-31T00:00:00.000Z</v></c>');
        }
        xml = xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
        xml = xml.replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g, '<$1x:$2');
        zip.file(entry.name, xml);
      }
      const archivo = path.join(tmp, 'prefijado.xlsx');
      await fs.writeFile(archivo, await zip.generateAsync({ type: 'nodebuffer' }));
      const before = await fs.readFile(archivo);
      const { libro: leido } = await leerLibroERP(archivo);
      assert.equal(textoCelda(leido.getWorksheet('Clientes').getCell('B7')), 'ANONIMO & <PRUEBA>');
      const prep = prepararImportacion(leido, { crearPlanesHistoricos: true });
      assert.equal(prep.informe.resumen.errores, 0);
      assert.equal(prep.membresias[0].fechaInicio.toISOString(), '2026-10-01T00:00:00.000Z');
      assert.equal(prep.membresias[0].fechaFin.toISOString(), '2026-10-31T00:00:00.000Z');
      assert.deepEqual(await fs.readFile(archivo), before);
    });
    await prueba('aplicacion idempotente no altera contactos, PIN ni estado corregido', async () => {
      const db = baseMemoria();
      const first = await aplicarImportacion(prepararImportacion(libro(), { crearPlanesHistoricos: true }), db);
      assert.equal(first.resultado.sociosCreados, 2);
      assert.equal(first.resultado.membresiasCreadas, 2);
      assert.equal(db.estado.planes[0].activo, false);
      const s = db.estado.miembros[0];
      assert.equal(s.pinCambiado, false);
      assert.equal(s.pinTemporalHasta, null);
      assert.equal(s.portalVersion, 0);
      assert.equal(bcrypt.compareSync('001277', s.pinHash), false);
      assert.equal(bcrypt.compareSync('01234567', s.pinHash), false);
      s.telefono = '999111222'; s.pinHash = 'PIN_CAMBIADO_POR_RECEPCION'; s.pinCambiado = true; s.portalVersion = 1;
      db.estado.membresias[0].estado = 'anulada';
      const second = await aplicarImportacion(prepararImportacion(libro(), { crearPlanesHistoricos: true }), db);
      assert.equal(second.resultado.sociosCreados, 0);
      assert.equal(second.resultado.sociosExistentes, 2);
      assert.equal(second.resultado.membresiasCreadas, 0);
      assert.equal(second.resultado.membresiasExistentes, 2);
      assert.equal(db.estado.miembros[0].telefono, '999111222');
      assert.equal(db.estado.miembros[0].pinHash, 'PIN_CAMBIADO_POR_RECEPCION');
      assert.equal(db.estado.miembros[0].portalVersion, 1);
      assert.equal(db.estado.membresias[0].estado, 'anulada');
    });
    await prueba('DNI existente sin codigo y codigo con otra identidad revierten todo', async () => {
      const db = baseMemoria({ miembros: [{ id: 'otro', codigoERP: null, dni: '01234567', documentoERP: null, nombres: 'EXISTENTE', apellidos: 'PRUEBA' }], planes: [], membresias: [] });
      await assert.rejects(() => aplicarImportacion(prepararImportacion(libro(), { crearPlanesHistoricos: true }), db), ImportacionBloqueada);
      assert.equal(db.estado.miembros.length, 1);
      assert.equal(db.estado.planes.length, 0);
      assert.equal(db.estado.membresias.length, 0);
      db.estado.miembros[0].codigoERP = '001277';
      await assert.rejects(() => aplicarImportacion(prepararImportacion(libro(), { crearPlanesHistoricos: true }), db), ImportacionBloqueada);
      assert.equal(db.estado.miembros.length, 1);
    });
    await prueba('plan desconocido requiere decision explicita y mapeo debe existir', async () => {
      assert(prepararImportacion(libro()).informe.resumen.errores > 0);
      const db = baseMemoria();
      await assert.rejects(() => aplicarImportacion(prepararImportacion(libro(), { planes: { 'PLAN DEMO': 'no-existe' } }), db), ImportacionBloqueada);
      assert.equal(db.estado.miembros.length, 0);
      assert.equal(db.estado.planes.length, 0);
    });
    await prueba('celulares se validan antes de habilitar WhatsApp y compartidos se advierten', () => {
      assert.equal(celularERP('+51 987 654 321'), '987654321');
      assert.equal(celularERP('987654321 / 912345678'), null);
      assert.equal(celularERP('987654321 ext 2'), null);
      const wb = libro(); wb.getWorksheet('Clientes').getCell('E8').value = '987654321';
      assert.equal(prepararImportacion(wb, { crearPlanesHistoricos: true }).informe.resumen.celularesCompartidos, 1);
    });
    console.log(`${comprobaciones} pruebas de importacion aprobadas.`);
  } finally {
    // La ruta es un directorio temporal creado por esta prueba y validado antes de borrarlo.
    const resolved = path.resolve(tmp);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
