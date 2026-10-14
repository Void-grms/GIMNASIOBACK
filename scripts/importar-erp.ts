/** Importador del archivo ERP. Por defecto valida; solo --apply abre la base. */
import * as ExcelJS from 'exceljs';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { MS_DIA, soloFecha } from '../src/common/fechas';

export type Incidencia = {
  gravedad: 'error' | 'aviso';
  hoja: 'Clientes' | 'Historial' | 'Base' | 'Archivo';
  fila?: number;
  codigoERP?: string;
  motivo: string;
};
export type Opciones = {
  origen?: string;
  planes?: Record<string, string>;
  crearPlanesHistoricos?: boolean;
};
type SocioERP = {
  fila: number; codigoERP: string; dni: string | null; documentoERP: string | null;
  nombres: string; apellidos: string; telefono: string | null; email: string | null;
  notas: string;
};
type MembresiaERP = {
  fila: number; codigoERP: string; codigoSocio: string; planId: string;
  fechaInicio: Date; fechaFin: Date; precioPagado: number; estado: string;
  estadoERP: string; observacion: string;
};
type PlanHistorico = { id: string; nombre: string; duracionDias: number; precio: number };
export type Informe = {
  version: 1;
  origen: string;
  fuenteSHA256?: string;
  modo: 'simulacion' | 'aplicado' | 'bloqueado';
  resumen: {
    filasClientes: number; sociosPreparados: number; dniPendientes: number;
    celularesValidos: number; celularesCompartidos: number;
    filasHistorial: number; membresiasPreparadas: number; membresiasOmitidas: number;
    planesHistoricos: number; errores: number; avisos: number;
  };
  planesERP: Array<{ nombre: string; filas: number; duraciones: Record<string, number>; precios: Record<string, number> }>;
  incidencias: Incidencia[];
  resultado?: { sociosCreados: number; sociosExistentes: number; membresiasCreadas: number; membresiasExistentes: number; planesCreados: number };
};
export type Preparacion = {
  socios: SocioERP[]; membresias: MembresiaERP[]; planes: PlanHistorico[]; informe: Informe;
};

export const encabezadosClientes = ['Código socio ERP', 'Nombres', 'Apellidos', 'Documento', 'Celular', 'Teléfono', 'Correo', 'Planes con estado Activo en ERP', 'Último plan por inicio (derivado)', 'Inicio último plan (derivado)', 'Fin último plan (derivado)', 'Contratos en historial', 'Referencia local cliente', 'Código unidad', 'Código sede', 'Género original'];
export const encabezadosHistorial = ['Ordinal informe', 'Código socio ERP', 'Nombre del cliente', 'Estado ERP', 'Plan registrado', 'Fecha inicio', 'Fecha fin', 'Costo registrado', 'Inscripción informe', 'Tipo de venta', 'Origen', 'Código membresía ERP', 'Referencia local membresía', 'Fecha creación registro', 'Código estado ERP', 'Código unidad', 'Código sede', 'Revisar fechas'];
const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Conserva ceros de texto y de formatos Excel como 00000000; nunca rellena un DNI por suposicion. */
export function textoCelda(celda: ExcelJS.Cell): string {
  let v: any = celda.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'formula' in v) v = v.result;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((p: any) => p.text).join('').trim();
  if (typeof v === 'object' && 'text' in v) return String(v.text).trim();
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && /^0+$/.test(celda.numFmt || '')) {
    return String(v).padStart(celda.numFmt.length, '0');
  }
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  return '';
}

export function fechaERP(valor: unknown, date1904 = false): Date | null {
  if (valor instanceof Date) return Number.isFinite(valor.getTime()) ? soloFecha(valor) : null;
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    // ExcelJS suele entregar Date; este camino cubre seriales sin formato de fecha.
    const base = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
    const d = new Date(base + Math.floor(valor) * MS_DIA);
    return d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100 ? soloFecha(d) : null;
  }
  if (typeof valor !== 'string') return null;
  const t = valor.trim();
  // Excel usa tambien t="d" con ISO8601; son dias del negocio, no una fecha por defecto.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0{1,3})?Z)?$/.exec(t);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!iso && !local) return null;
  const [y, m, day] = iso ? [+iso[1], +iso[2], +iso[3]] : [+local[3], +local[2], +local[1]];
  const d = new Date(Date.UTC(y, m - 1, day));
  return y >= 1900 && y <= 2100 && d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === day ? d : null;
}

/** Normalizacion conservadora: solo celulares peruanos completos permiten WhatsApp. */
export function celularERP(texto: string): string | null {
  if (!/^[+\d\s().-]*$/.test(texto)) return null;
  let digitos = texto.replace(/\D/g, '');
  if (/^519\d{8}$/.test(digitos)) digitos = digitos.slice(2);
  return /^9\d{8}$/.test(digitos) ? digitos : null;
}

const namespaceSpreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const escaparXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escaparAtributo = (s: string) => escaparXml(s).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

/** ExcelJS reconoce SpreadsheetML sin prefijo. Se normaliza XML con namespaces, nunca con sustitucion de datos. */
export function normalizarXmlSpreadsheet(xml: string, baseRelacion?: string): string {
  const parser = new SaxesParser({ xmlns: true });
  const salida: string[] = [];
  const defaults: string[] = [''];
  parser.on('opentag', tag => {
    const esSpreadsheet = tag.uri === namespaceSpreadsheet;
    const nombre = esSpreadsheet ? tag.local : tag.name;
    let defaultNamespace = defaults[defaults.length - 1];
    const attrs: string[] = [];
    for (const atributo of Object.values(tag.attributes)) {
      if (atributo.name === 'xmlns') {
        defaultNamespace = atributo.value;
        if (esSpreadsheet) continue;
      }
      const esRelacionInterna = tag.uri === 'http://schemas.openxmlformats.org/package/2006/relationships' && tag.local === 'Relationship' && tag.attributes.TargetMode?.value !== 'External';
      let valor = esRelacionInterna && atributo.name === 'Target' && atributo.value.startsWith('/') && baseRelacion !== undefined
        ? path.posix.relative(baseRelacion, atributo.value.slice(1)) : atributo.value;
      // ExcelJS no soporta t="d": lo trata como numero y convierte 2026-... en serial 2026.
      // Se mantiene el ISO original como texto para que fechaERP lo valide sin perder el dia.
      if (esSpreadsheet && tag.local === 'c' && atributo.name === 't' && atributo.value === 'd') valor = 'str';
      attrs.push(`${atributo.name}="${escaparAtributo(valor)}"`);
    }
    if (esSpreadsheet && defaultNamespace !== namespaceSpreadsheet) {
      attrs.push(`xmlns="${namespaceSpreadsheet}"`);
      defaultNamespace = namespaceSpreadsheet;
    } else if (esSpreadsheet && Object.values(tag.attributes).some(a => a.name === 'xmlns')) {
      attrs.push(`xmlns="${namespaceSpreadsheet}"`);
    }
    defaults.push(defaultNamespace);
    salida.push(`<${nombre}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
  });
  parser.on('closetag', tag => { salida.push(`</${tag.uri === namespaceSpreadsheet ? tag.local : tag.name}>`); defaults.pop(); });
  parser.on('text', texto => salida.push(escaparXml(texto)));
  parser.on('cdata', texto => salida.push(escaparXml(texto)));
  parser.on('doctype', () => { throw new Error('No se admiten declaraciones externas en el XML del archivo'); });
  parser.write(xml).close();
  return salida.join('');
}

export async function leerLibroERP(archivo: string): Promise<{ libro: ExcelJS.Workbook; fuenteSHA256: string }> {
  const contenido = await fs.readFile(archivo);
  const fuenteSHA256 = createHash('sha256').update(contenido).digest('hex');
  const zip = await JSZip.loadAsync(contenido);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels'))) continue;
    const xml = await entry.async('string');
    if (xml.includes(namespaceSpreadsheet)) zip.file(entry.name, normalizarXmlSpreadsheet(xml));
    else if (entry.name.endsWith('.rels')) {
      const baseRelacion = entry.name === '_rels/.rels' ? '' : path.posix.dirname(entry.name.replace('/_rels/', '/').replace(/\.rels$/, ''));
      zip.file(entry.name, normalizarXmlSpreadsheet(xml, baseRelacion));
    }
  }
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(await zip.generateAsync({ type: 'nodebuffer' }) as any);
  return { libro, fuenteSHA256 };
}

function agregar(prep: Preparacion, incidencia: Incidencia) {
  prep.informe.incidencias.push(incidencia);
  prep.informe.resumen[incidencia.gravedad === 'error' ? 'errores' : 'avisos']++;
}

function validarHoja(prep: Preparacion, libro: ExcelJS.Workbook, nombre: 'Clientes' | 'Historial', headers: string[]) {
  const hoja = libro.getWorksheet(nombre);
  if (!hoja) { agregar(prep, { gravedad: 'error', hoja: 'Archivo', motivo: `Falta la hoja ${nombre}` }); return null; }
  if (headers.some((h, i) => normalizar(textoCelda(hoja.getCell(6, i + 1))) !== normalizar(h))) {
    agregar(prep, { gravedad: 'error', hoja: nombre, fila: 6, motivo: 'Encabezados distintos del formato exportado; no se importan columnas por suposicion' });
    return null;
  }
  return hoja;
}

function filaVacia(fila: ExcelJS.Row) {
  return Object.values(fila.values).every(v => v === null || v === undefined || v === '');
}

export function prepararImportacion(libro: ExcelJS.Workbook, opciones: Opciones = {}): Preparacion {
  const origen = opciones.origen || 'forcesgym';
  if (!/^[a-z0-9_-]{1,40}$/.test(origen)) throw new Error('Origen invalido: use letras minusculas, numeros, guion o guion bajo (maximo 40)');
  const prep: Preparacion = {
    socios: [], membresias: [], planes: [],
    informe: { version: 1, origen, modo: 'simulacion', resumen: { filasClientes: 0, sociosPreparados: 0, dniPendientes: 0, celularesValidos: 0, celularesCompartidos: 0, filasHistorial: 0, membresiasPreparadas: 0, membresiasOmitidas: 0, planesHistoricos: 0, errores: 0, avisos: 0 }, planesERP: [], incidencias: [] },
  };
  const clientes = validarHoja(prep, libro, 'Clientes', encabezadosClientes);
  const historial = validarHoja(prep, libro, 'Historial', encabezadosHistorial);
  if (!clientes || !historial) return prep;
  const codigos = new Map<string, number>();
  const documentos = new Map<string, number>();
  const telefonos = new Map<string, SocioERP[]>();
  clientes.eachRow((fila, n) => {
    if (n < 7 || filaVacia(fila)) return;
    prep.informe.resumen.filasClientes++;
    const codigoERP = textoCelda(fila.getCell(1));
    const nombres = textoCelda(fila.getCell(2));
    const apellidos = textoCelda(fila.getCell(3));
    const documentoERP = textoCelda(fila.getCell(4)) || null;
    const dni = documentoERP && /^\d{8}$/.test(documentoERP) ? documentoERP : null;
    if (!codigoERP || !nombres) {
      agregar(prep, { gravedad: 'error', hoja: 'Clientes', fila: n, codigoERP: codigoERP || undefined, motivo: 'Falta codigo ERP o nombres; no se crea una identidad ficticia' }); return;
    }
    if (codigos.has(codigoERP)) agregar(prep, { gravedad: 'error', hoja: 'Clientes', fila: n, codigoERP, motivo: `Codigo ERP repetido; primera fila ${codigos.get(codigoERP)}` });
    else codigos.set(codigoERP, n);
    if (dni && documentos.has(dni)) agregar(prep, { gravedad: 'error', hoja: 'Clientes', fila: n, codigoERP, motivo: `DNI compartido con otra ficha; primera fila ${documentos.get(dni)}` });
    else if (dni) documentos.set(dni, n);
    if (!dni) {
      prep.informe.resumen.dniPendientes++;
      agregar(prep, { gravedad: 'aviso', hoja: 'Clientes', fila: n, codigoERP, motivo: 'Documento pendiente de verificar; se conserva original y se importa DNI nulo' });
    }
    const celularOriginal = textoCelda(fila.getCell(5));
    const fijoOriginal = textoCelda(fila.getCell(6));
    const telefono = celularERP(celularOriginal);
    const correoOriginal = textoCelda(fila.getCell(7));
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoOriginal) ? correoOriginal : null;
    const socio: SocioERP = { fila: n, codigoERP, nombres, apellidos, dni, documentoERP, telefono, email,
      notas: JSON.stringify({ origenERP: origen, referenciaERP: textoCelda(fila.getCell(13)), celularOriginal: celularOriginal || null, telefonoOriginal: fijoOriginal || null, correoOriginal: correoOriginal || null, consentimientoImportado: false }),
    };
    prep.socios.push(socio);
    if (telefono) { prep.informe.resumen.celularesValidos++; telefonos.set(telefono, [...(telefonos.get(telefono) || []), socio]); }
    else agregar(prep, { gravedad: 'aviso', hoja: 'Clientes', fila: n, codigoERP, motivo: 'Celular ausente o no valido para WhatsApp; original conservado en notas privadas' });
  });
  for (const grupo of telefonos.values()) {
    if (grupo.length < 2) continue;
    prep.informe.resumen.celularesCompartidos++;
    for (const s of grupo) agregar(prep, { gravedad: 'aviso', hoja: 'Clientes', fila: s.fila, codigoERP: s.codigoERP, motivo: 'Celular compartido; verificar identidad antes de emitir una activacion' });
  }
  const claves = new Map<string, number>();
  const planes = new Map<string, PlanHistorico>();
  const stats = new Map<string, Informe['planesERP'][number]>();
  historial.eachRow((fila, n) => {
    if (n < 7 || filaVacia(fila)) return;
    prep.informe.resumen.filasHistorial++;
    const codigoSocio = textoCelda(fila.getCell(2));
    const estadoERP = textoCelda(fila.getCell(4));
    const nombrePlan = textoCelda(fila.getCell(5));
    const inicio = fechaERP(fila.getCell(6).value, libro.properties.date1904);
    const fin = fechaERP(fila.getCell(7).value, libro.properties.date1904);
    const precioTexto = textoCelda(fila.getCell(8));
    const precio = /^\d+(\.\d{1,2})?$/.test(precioTexto) ? Number(precioTexto) : NaN;
    const codigoOriginal = textoCelda(fila.getCell(12));
    const referencia = textoCelda(fila.getCell(13));
    const clave = codigoOriginal ? `${origen}:id:${codigoOriginal}` : referencia ? `${origen}:ref:${referencia}` : '';
    if (clave && claves.has(clave)) agregar(prep, { gravedad: 'error', hoja: 'Historial', fila: n, codigoERP: codigoSocio, motivo: `Identificador de membresia repetido; primera fila ${claves.get(clave)}` });
    else if (clave) claves.set(clave, n);
    const duracion = inicio && fin ? Math.round((fin.getTime() - inicio.getTime()) / MS_DIA) + 1 : null;
    let stat = stats.get(nombrePlan);
    if (!stat) { stat = { nombre: nombrePlan, filas: 0, duraciones: {}, precios: {} }; stats.set(nombrePlan, stat); }
    stat.filas++;
    if (duracion !== null) stat.duraciones[String(duracion)] = (stat.duraciones[String(duracion)] || 0) + 1;
    if (Number.isFinite(precio)) stat.precios[String(precio)] = (stat.precios[String(precio)] || 0) + 1;
    let motivo = '';
    if (!codigos.has(codigoSocio)) motivo = 'Socio del historial no encontrado en Clientes';
    else if (!clave) motivo = 'Falta codigo y referencia local de membresia; no se inventa identificador por numero de fila';
    else if (!inicio || !fin) motivo = 'Fecha de inicio o fin ausente/invalida; no se sustituye por hoy';
    else if (duracion <= 0) motivo = 'Fecha de inicio posterior al fin; requiere correccion en la fuente';
    else if (!Number.isFinite(precio) || precio > 100000) motivo = 'Costo invalido; requiere revision';
    else if (!nombrePlan) motivo = 'Plan sin nombre; requiere revision';
    else if (!['activo', 'vencido'].includes(normalizar(estadoERP))) motivo = 'Estado ERP ambiguo o desconocido; requiere revision y no habilita acceso';
    if (motivo) { agregar(prep, { gravedad: 'aviso', hoja: 'Historial', fila: n, codigoERP: codigoSocio, motivo }); return; }
    let planId = opciones.planes && Object.prototype.hasOwnProperty.call(opciones.planes, nombrePlan) ? opciones.planes[nombrePlan] : undefined;
    if (!planId && opciones.crearPlanesHistoricos) {
      // Cada variante describe exactamente una duracion/precio de la fuente y queda fuera de venta.
      planId = `erp_${createHash('sha256').update(JSON.stringify([origen, nombrePlan, duracion, precio])).digest('hex').slice(0, 32)}`;
      planes.set(planId, { id: planId, nombre: nombrePlan, duracionDias: duracion, precio });
    }
    if (!planId) {
      agregar(prep, { gravedad: 'error', hoja: 'Historial', fila: n, codigoERP: codigoSocio, motivo: 'Plan sin mapeo: proporcionar --planes o elegir --crear-planes-historicos' }); return;
    }
    prep.membresias.push({ fila: n, codigoERP: clave, codigoSocio, planId, fechaInicio: inicio, fechaFin: fin, precioPagado: precio,
      estado: normalizar(estadoERP) === 'activo' ? 'activa' : 'vencida', estadoERP,
      observacion: JSON.stringify({ origenERP: origen, codigoMembresiaERP: codigoOriginal || null, referenciaERP: referencia || null, estadoERP, costoHistoricoSinPago: true }),
    });
  });
  prep.planes = [...planes.values()];
  prep.informe.planesERP = [...stats.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  Object.assign(prep.informe.resumen, { sociosPreparados: prep.socios.length, membresiasPreparadas: prep.membresias.length, membresiasOmitidas: prep.informe.resumen.filasHistorial - prep.membresias.length, planesHistoricos: prep.planes.length });
  return prep;
}

export class ImportacionBloqueada extends Error {
  constructor(public informe: Informe) { super('Importacion bloqueada; revise el informe de incidencias'); }
}

/** Prisma se inyecta: la simulacion ni crea un cliente ni consulta la base. */
export async function aplicarImportacion(prep: Preparacion, prisma: any): Promise<Informe> {
  if (prep.informe.resumen.errores) { prep.informe.modo = 'bloqueado'; throw new ImportacionBloqueada(prep.informe); }
  const resultado = { sociosCreados: 0, sociosExistentes: 0, membresiasCreadas: 0, membresiasExistentes: 0, planesCreados: 0 };
  // El hash inutilizable para login bloquea el portal hasta una activacion; nunca se revela un PIN.
  const hashes = new Map<string, string>();
  try {
    // Solo se preparan hashes para fichas nuevas; una segunda ejecucion no gasta tiempo ni toca credenciales.
    const codigosExistentes = new Set<string>();
    for (let i = 0; i < prep.socios.length; i += 200) {
      const actuales = await prisma.member.findMany({ where: { codigoERP: { in: prep.socios.slice(i, i + 200).map(s => s.codigoERP) } }, select: { codigoERP: true } });
      for (const actual of actuales) codigosExistentes.add(actual.codigoERP);
    }
    for (const socio of prep.socios) if (!codigosExistentes.has(socio.codigoERP)) hashes.set(socio.codigoERP, await bcrypt.hash(randomBytes(32).toString('base64url'), 10));
    await prisma.$transaction(async (tx: any) => {
      // SQLite tiene limite de parametros; lotes pequenos sirven tambien en PostgreSQL.
      const actuales: any[] = [];
      for (let i = 0; i < prep.socios.length; i += 200) {
        const lote = prep.socios.slice(i, i + 200);
        actuales.push(...await tx.member.findMany({ where: { OR: [{ codigoERP: { in: lote.map(s => s.codigoERP) } }, { dni: { in: lote.map(s => s.dni).filter(Boolean) } }] } }));
      }
      const porCodigo = new Map(actuales.filter(s => s.codigoERP).map(s => [s.codigoERP, s]));
      const porDni = new Map(actuales.filter(s => s.dni).map(s => [s.dni, s]));
      for (const s of prep.socios) {
        const actual: any = porCodigo.get(s.codigoERP);
        const mismoDni: any = s.dni && porDni.get(s.dni);
        if (mismoDni && mismoDni.id !== actual?.id) agregar(prep, { gravedad: 'error', hoja: 'Base', fila: s.fila, codigoERP: s.codigoERP, motivo: 'DNI ya vinculado a otro socio; no se fusionan fichas' });
        if (actual && (normalizar(actual.nombres) !== normalizar(s.nombres) || normalizar(actual.apellidos) !== normalizar(s.apellidos) || (actual.documentoERP ?? '') !== (s.documentoERP ?? ''))) {
          agregar(prep, { gravedad: 'error', hoja: 'Base', fila: s.fila, codigoERP: s.codigoERP, motivo: 'Codigo ERP ya pertenece a una identidad distinta; no se sobrescribe' });
        }
      }
      const planIds = [...new Set(prep.membresias.map(m => m.planId))];
      const planesActuales: any[] = [];
      for (let i = 0; i < planIds.length; i += 200) planesActuales.push(...await tx.plan.findMany({ where: { id: { in: planIds.slice(i, i + 200) } } }));
      const porPlan = new Map(planesActuales.map(p => [p.id, p]));
      const porHistorico = new Map(prep.planes.map(p => [p.id, p]));
      for (const planId of planIds) {
        const existente: any = porPlan.get(planId);
        const historico = porHistorico.get(planId);
        if (!existente && !historico) agregar(prep, { gravedad: 'error', hoja: 'Base', motivo: 'El mapeo referencia un plan que no existe en la base' });
        if (existente && historico && (existente.nombre !== historico.nombre || existente.duracionDias !== historico.duracionDias || existente.precio !== historico.precio || existente.activo)) agregar(prep, { gravedad: 'error', hoja: 'Base', motivo: 'Identificador de plan historico en conflicto; no se sobrescribe el catalogo' });
      }
      const membresiasActuales: any[] = [];
      for (let i = 0; i < prep.membresias.length; i += 200) membresiasActuales.push(...await tx.membership.findMany({ where: { codigoERP: { in: prep.membresias.slice(i, i + 200).map(m => m.codigoERP) } } }));
      const porMembresia = new Map(membresiasActuales.map(m => [m.codigoERP, m]));
      for (const m of prep.membresias) {
        const actual: any = porMembresia.get(m.codigoERP);
        const socio: any = porCodigo.get(m.codigoSocio);
        if (actual && (actual.memberId !== socio?.id || actual.planId !== m.planId || new Date(actual.fechaInicio).getTime() !== m.fechaInicio.getTime() || new Date(actual.fechaFin).getTime() !== m.fechaFin.getTime() || actual.precioPagado !== m.precioPagado || actual.estadoERP !== m.estadoERP)) agregar(prep, { gravedad: 'error', hoja: 'Base', fila: m.fila, codigoERP: m.codigoSocio, motivo: 'Identificador de membresia en conflicto; no se sobrescribe historial' });
      }
      if (prep.informe.resumen.errores) throw new ImportacionBloqueada(prep.informe);
      for (const p of prep.planes) {
        if (porPlan.has(p.id)) continue;
        await tx.plan.create({ data: { ...p, activo: false, descripcion: `Historico importado (${prep.informe.origen}); duracion y precio originales. No disponible para nuevas ventas.` } });
        resultado.planesCreados++;
      }
      for (const s of prep.socios) {
        if (porCodigo.has(s.codigoERP)) { resultado.sociosExistentes++; continue; }
        const { fila, ...datos } = s;
        const pinHash = hashes.get(s.codigoERP) || await bcrypt.hash(randomBytes(32).toString('base64url'), 10);
        const creado = await tx.member.create({ data: { ...datos, pinHash, pinCambiado: false, pinTemporalHasta: null, portalVersion: 0, credential: { create: { secret: randomBytes(32).toString('hex') } } } });
        porCodigo.set(s.codigoERP, creado);
        resultado.sociosCreados++;
      }
      for (const m of prep.membresias) {
        if (porMembresia.has(m.codigoERP)) { resultado.membresiasExistentes++; continue; }
        const { fila, codigoSocio, ...datos } = m;
        const socio: any = porCodigo.get(codigoSocio);
        await tx.membership.create({ data: { ...datos, memberId: socio.id } });
        resultado.membresiasCreadas++;
      }
    }, { maxWait: 30000, timeout: 120000 });
    prep.informe.modo = 'aplicado';
    prep.informe.resultado = resultado;
    return prep.informe;
  } catch (e) {
    prep.informe.modo = 'bloqueado';
    if (!(e instanceof ImportacionBloqueada)) {
      // No se incluyen errores Prisma con valores de filas/credenciales en logs.
      agregar(prep, { gravedad: 'error', hoja: 'Base', motivo: 'La transaccion fallo y fue revertida; revise conexion, esquema y restricciones de la base' });
    }
    throw new ImportacionBloqueada(prep.informe);
  }
}

export async function importarArchivo(archivo: string, opciones: Opciones & { apply?: boolean; crearCliente?: () => Promise<any> } = {}): Promise<Informe> {
  const { libro, fuenteSHA256 } = await leerLibroERP(archivo);
  const prep = prepararImportacion(libro, opciones);
  prep.informe.fuenteSHA256 = fuenteSHA256;
  if (!opciones.apply) return prep.informe;
  if (prep.informe.resumen.errores) { prep.informe.modo = 'bloqueado'; throw new ImportacionBloqueada(prep.informe); }
  if (!opciones.crearCliente) throw new Error('Falta cliente de base explicito para aplicar');
  const prisma = await opciones.crearCliente();
  try { return await aplicarImportacion(prep, prisma); } finally { await prisma.$disconnect(); }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (nombre: string) => { const i = args.indexOf(nombre); return i < 0 ? undefined : args[i + 1]; };
  const flags = new Set(['--archivo', '--report', '--planes', '--origen', '--apply', '--crear-planes-historicos', '--help']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!flags.has(a)) throw new Error('Argumento desconocido; use --help');
    if (['--archivo', '--report', '--planes', '--origen'].includes(a)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Falta valor para ${a}`);
      i++;
    }
  }
  if (args.includes('--help')) {
    console.log('npx ts-node scripts/importar-erp.ts --archivo archivo.xlsx [--report informe.json] [--planes mapeo.json | --crear-planes-historicos] [--origen forcesgym] [--apply]\nSin --apply: solo lectura del Excel y reporte, sin conexion a base. Con --apply: DATABASE_URL debe estar definida explicitamente en el entorno.'); return;
  }
  const archivo = value('--archivo');
  if (!archivo || path.extname(archivo).toLowerCase() !== '.xlsx') throw new Error('Indique --archivo con un archivo .xlsx');
  const reporte = path.resolve(value('--report') || path.join(os.tmpdir(), `migracion-erp-${Date.now()}.json`));
  if (path.extname(reporte).toLowerCase() !== '.json' || reporte.toLowerCase() === path.resolve(archivo).toLowerCase()) throw new Error('El reporte debe ser JSON y distinto del archivo fuente');
  const aplicar = args.includes('--apply');
  if (aplicar && !process.env.DATABASE_URL) throw new Error('Defina DATABASE_URL explicitamente en el entorno antes de --apply');
  const planesFile = value('--planes');
  if (planesFile && reporte.toLowerCase() === path.resolve(planesFile).toLowerCase()) throw new Error('El reporte debe ser distinto del mapeo de planes');
  const planes = planesFile ? JSON.parse(await fs.readFile(planesFile, 'utf8')) : undefined;
  if (planes && (typeof planes !== 'object' || Array.isArray(planes) || Object.entries(planes).some(([nombre, id]) => !nombre.trim() || typeof id !== 'string' || !id.trim()))) throw new Error('El mapeo --planes debe ser un objeto JSON nombreERP: planId');
  let informe: Informe;
  try {
    informe = await importarArchivo(path.resolve(archivo), { planes, origen: value('--origen'), crearPlanesHistoricos: args.includes('--crear-planes-historicos'), apply: aplicar,
      crearCliente: async () => { const { PrismaClient } = await import('@prisma/client'); return new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }); },
    });
  } catch (e) {
    if (!(e instanceof ImportacionBloqueada)) throw e;
    informe = e.informe;
    process.exitCode = 1;
  }
  await fs.mkdir(path.dirname(reporte), { recursive: true });
  await fs.writeFile(reporte, JSON.stringify(informe, null, 2), { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ modo: informe.modo, resumen: informe.resumen, resultado: informe.resultado, reporte }, null, 2));
  if (informe.resumen.errores) process.exitCode = 1;
}

if (require.main === module) main().catch(() => { console.error('No se pudo ejecutar la migracion. Revise argumentos, archivo/mapeo, permisos y dependencias; use --help. No se imprimen datos privados.'); process.exitCode = 1; });
