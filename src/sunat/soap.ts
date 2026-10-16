import { SaxesParser } from 'saxes';
import JSZip from 'jszip';

export const BETA_URL =
  'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService';
export function camposXml(xml: string): Map<string, string[]> {
  if (Buffer.byteLength(xml) > 2_000_000)
    throw new Error('Respuesta XML demasiado grande');
  const values = new Map<string, string[]>(),
    stack: { name: string; text: string }[] = [];
  const p = new SaxesParser({ xmlns: true });
  p.on('doctype', () => {
    throw new Error('DTD no permitido');
  });
  p.on('error', () => {
    throw new Error('Respuesta XML invalida');
  });
  p.on('opentag', (t) => {
    if (stack.length > 40) throw new Error('XML demasiado profundo');
    stack.push({ name: t.local, text: '' });
  });
  const add = (s: string) => {
    if (stack.length) stack[stack.length - 1].text += s;
  };
  p.on('text', add);
  p.on('cdata', add);
  p.on('closetag', () => {
    const key = '/' + stack.map((t) => t.name).join('/');
    const t = stack.pop();
    if (t.text.trim())
      values.set(key, [...(values.get(key) || []), t.text.trim()]);
  });
  p.write(xml).close();
  return values;
}
function valor(v: Map<string, string[]>, suffix: string): string | undefined {
  const a = [...v].filter(([k]) => k.endsWith(suffix)).flatMap(([, x]) => x);
  if (a.length > 1) throw new Error('Respuesta ambigua');
  return a[0];
}
export function interpretarSoap(xml: string) {
  const v = camposXml(xml);
  const fallo =
    valor(v, '/Fault/faultstring') || valor(v, '/Fault/Reason/Text');
  if (fallo)
    return {
      fallo: fallo.slice(0, 700),
      codigo: valor(v, '/Fault/faultcode')?.match(/\d{3,5}/)?.[0] || 'SOAP',
    };
  const application = valor(v, '/sendBillResponse/applicationResponse');
  const cdr = application || valor(v, '/getStatusResponse/status/content');
  if (cdr && (!/^[A-Za-z0-9+/=\s]+$/.test(cdr) || cdr.length > 2_000_000))
    throw new Error('CDR no reconocido');
  return {
    cdr: cdr?.replace(/\s/g, ''),
    ticket: valor(v, '/sendSummaryResponse/ticket'),
    codigo: valor(v, '/getStatusResponse/status/statusCode'),
  };
}
export async function leerCdr(base64: string, nombreArchivo: string) {
  const b = Buffer.from(base64, 'base64');
  if (!b.length || b.length > 1_000_000)
    throw new Error('CDR demasiado grande');
  // No checkCRC32 aqui: JSZip inflaria todo antes de poder verificar limites.
  const zip = await JSZip.loadAsync(b);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  if (files.length !== 1 || files[0].name !== `R-${nombreArchivo}.xml`)
    throw new Error('El CDR no corresponde al documento enviado');
  const f: any = files[0];
  if ((f._data?.uncompressedSize ?? Infinity) > 1_000_000)
    throw new Error('CDR descomprimido demasiado grande');
  const xml = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const stream = f.internalStream('uint8array');
    stream.on('data', (data: Uint8Array) => {
      bytes += data.length;
      if (bytes > 1_000_000) {
        stream.pause();
        reject(new Error('CDR demasiado grande'));
      } else chunks.push(Buffer.from(data));
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.resume();
  });
  const values = camposXml(xml);
  const codigo = valor(values, '/DocumentResponse/Response/ResponseCode');
  const ref =
    valor(values, '/DocumentResponse/DocumentReference/ID') ||
    valor(values, '/DocumentResponse/Response/ReferenceID');
  const partes = nombreArchivo.split('-'),
    numero = partes.slice(2).join('-');
  if (
    !codigo ||
    !/^\d{1,5}$/.test(codigo) ||
    ![numero, nombreArchivo].includes(ref || '')
  )
    throw new Error('El CDR no permite verificar el resultado del documento');
  const descripcion =
    valor(values, '/DocumentResponse/Response/Description') ||
    'Respuesta de SUNAT BETA';
  const notas = [...values]
    .filter(([k]) => k.endsWith('/ApplicationResponse/Note'))
    .flatMap(([, v]) => v);
  return {
    codigo,
    mensaje: [descripcion, ...notas].join(' · ').slice(0, 1500),
    aceptado: codigo === '0',
    base64,
  };
}
const esc = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c],
  );
export async function enviarBeta(
  ruc: string,
  nombre: string,
  xml: string,
  ticket?: string,
) {
  if (
    !/^\d{11}$/.test(ruc) ||
    !/^[\w-]{1,80}$/.test(nombre) ||
    (ticket && !/^[\w.-]{1,100}$/.test(ticket))
  )
    throw new Error('Identificacion de ensayo invalida');
  const zip = new JSZip();
  zip.file(nombre + '.xml', Buffer.from(xml, 'utf8'));
  const content = ticket
    ? ''
    : await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  const method = ticket ? 'getStatus' : 'sendBill';
  const body = ticket
    ? `<ticket>${esc(ticket)}</ticket>`
    : `<fileName>${esc(nombre)}.zip</fileName><contentFile>${content}</contentFile>`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><soap:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${ruc}MODDATOS</wsse:Username><wsse:Password>moddatos</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header><soap:Body><ser:${method}>${body}</ser:${method}></soap:Body></soap:Envelope>`;
  // No URLs configurables, redirecciones ni desactivacion TLS. Nunca usa SOL real.
  const response = await fetch(BETA_URL, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'urn:' + method,
    },
    body: envelope,
    signal: AbortSignal.timeout(25000),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SUNAT no devolvio una respuesta');
  const parts: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2_000_000) throw new Error('Respuesta demasiado grande');
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const parsed = interpretarSoap(Buffer.concat(parts).toString('utf8'));
  if (!response.ok && !parsed.fallo)
    throw new Error('SUNAT BETA no esta disponible');
  return parsed;
}
