/** Ensayos aislados. Las llamadas de red se simulan; nunca usan SOL ni ventas reales. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { cifrar, descifrar } from '../src/sunat/crypto';
import { interpretarSoap, camposXml, leerCdr } from '../src/sunat/soap';
import { SunatService } from '../src/sunat/sunat.service';
import { SettingsService } from '../src/settings/settings.service';
import { esRuc } from '../src/common/validadores';
import { ReceiptsService } from '../src/receipts/receipts.service';

const nombre = '20123456789-03-BTE1-1';
async function cdr(
  archivo = nombre,
  referencia = 'BTE1-1',
  codigo = '0',
  extra = '',
) {
  const zip = new JSZip();
  zip.file(
    `R-${archivo}.xml`,
    `<ApplicationResponse><DocumentResponse><Response><ResponseCode>${codigo}</ResponseCode><Description>Resultado ficticio</Description></Response><DocumentReference><ID>${referencia}</ID></DocumentReference></DocumentResponse>${extra}</ApplicationResponse>`,
  );
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
export async function probarFormatoSunat() {
  process.env.SUNAT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const privado = 'secreto-ficticio-de-prueba',
    envelope = cifrar(privado, 'config');
  assert(!envelope.includes(privado));
  assert.equal(descifrar(envelope, 'config'), privado);
  assert.notEqual(cifrar(privado, 'config'), envelope);
  assert.throws(() => descifrar(envelope, 'xml:otro'));
  const partes = envelope.split(':');
  partes[2] = Buffer.alloc(16).toString('base64');
  assert.throws(() => descifrar(partes.join(':'), 'config'));
  const clave = process.env.SUNAT_ENCRYPTION_KEY;
  delete process.env.SUNAT_ENCRYPTION_KEY;
  assert.throws(() => cifrar(privado, 'config'));
  process.env.SUNAT_ENCRYPTION_KEY = clave;
  console.log(
    'ok cifrado autenticado, contexto, IV aleatorio y cierre sin clave',
  );
  // Casos sinteticos de borde, independientes de la formula implementada.
  for (const ruc of [
    '20100000050',
    '20100000131',
    '20100000190',
    '20100000220',
    '20100000271',
  ])
    assert(esRuc(ruc));
  for (const ruc of [
    '20100000051',
    '20100000130',
    '20100000191',
    '20100000221',
    '20100000270',
  ])
    assert(!esRuc(ruc));
  assert(esRuc('20131312955'));
  assert(!esRuc('18000000'));
  console.log('ok RUC de once digitos y verificadores de borde');
  let estado = 'aceptado',
    actualizaciones = 0;
  const recibos = new ReceiptsService(
    {
      receipt: {
        findUnique: async () => ({
          id: 'ficticio',
          anulado: false,
          estadoSunat: estado,
        }),
        update: async () => {
          actualizaciones++;
          return {};
        },
      },
    } as any,
    {} as any,
    {} as any,
  );
  for (estado of ['aceptado', 'pendiente', 'rechazado'])
    await assert.rejects(
      () => recibos.anular('ficticio', 'Prueba de baja local'),
      (e: any) => e.getStatus() === 400,
    );
  assert.equal(actualizaciones, 0);
  estado = 'no_aplica';
  await recibos.anular('ficticio', 'Prueba de recibo interno');
  assert.equal(actualizaciones, 1);
  console.log(
    'ok anulacion local solo modifica recibos internos y nunca simula una baja fiscal',
  );
  assert.equal((await leerCdr(await cdr(), nombre)).aceptado, true);
  assert.equal(
    (await leerCdr(await cdr(nombre, 'BTE1-1', '3244'), nombre)).aceptado,
    false,
  );
  await assert.rejects(async () =>
    leerCdr(await cdr(nombre, 'BTE1-99'), nombre),
  );
  await assert.rejects(async () => leerCdr(await cdr('otro'), nombre));
  const bomb = new JSZip();
  bomb.file(`R-${nombre}.xml`, 'X'.repeat(1_000_001));
  await assert.rejects(async () =>
    leerCdr(
      await bomb.generateAsync({ type: 'base64', compression: 'DEFLATE' }),
      nombre,
    ),
  );
  assert.throws(() =>
    camposXml(
      '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>',
    ),
  );
  assert.throws(() => camposXml('<x>'.repeat(45) + '</x>'.repeat(45)));
  assert.throws(() =>
    interpretarSoap(
      '<Envelope><sendBillResponse><applicationResponse>QQ==</applicationResponse><applicationResponse>Qg==</applicationResponse></sendBillResponse></Envelope>',
    ),
  );
  assert.equal(
    interpretarSoap(
      '<Envelope><sendSummaryResponse><ticket>123</ticket></sendSummaryResponse></Envelope>',
    ).ticket,
    '123',
  );
  assert.equal(
    interpretarSoap(
      '<Envelope><getStatusResponse><status><statusCode>98</statusCode></status></getStatusResponse></Envelope>',
    ).cdr,
    undefined,
  );
  console.log(
    'ok CDR rechazado, documento distinto, ZIP grande, DTD y XML ambiguo nunca se aceptan',
  );
}

export async function probarSunat(clientes: any[]) {
  const db = clientes[0],
    segundo = clientes[1];
  const motor = require('../src/sunat/engine'),
    soap = require('../src/sunat/soap');
  const originales = {
    disponible: motor.motorDisponible,
    motor: motor.ejecutarMotor,
    enviar: soap.enviarBeta,
  };
  const reales = async () =>
    Promise.all(
      ['payment', 'receipt', 'serie', 'membership', 'member'].map((m) =>
        db[m].count(),
      ),
    );
  const antes = await reales();
  let envios = 0,
    xmlGenerados = 0;
  let modo = 'aceptado';
  let nombres: string[] = [];
  const a = new SunatService(db),
    b = new SunatService(segundo);
  const procesarA = a.procesar.bind(a),
    procesarB = b.procesar.bind(b);
  // El runner conduce la cola para observar las transiciones de forma determinista.
  a.procesar = async () => {};
  b.procesar = async () => {};
  motor.motorDisponible = () => true;
  motor.ejecutarMotor = async (payload: any) => {
    if (payload.action === 'inspectCertificate')
      return {
        certificado: {
          subject: 'FICTICIO',
          esPrueba: false,
          validTo: '2030-01-01',
        },
      };
    xmlGenerados++;
    const d = payload.documento;
    return {
      nombreArchivo: `${d.ruc}-${d.tipo}-${d.serie}-${d.numero}`,
      firmaVerificada: true,
      xmlBase64: Buffer.from('<XML>PRUEBA FICTICIA</XML>').toString('base64'),
      hash: 'hash-ficticio',
    };
  };
  soap.enviarBeta = async (_ruc: string, n: string, xml: string) => {
    envios++;
    nombres.push(n);
    assert.equal(xml, '<XML>PRUEBA FICTICIA</XML>');
    await new Promise((r) => setTimeout(r, 15));
    if (modo === 'timeout') throw new Error('timeout');
    const ref = n.split('-').slice(2).join('-');
    return { cdr: await cdr(n, ref, modo === 'rechazado' ? '3244' : '0') };
  };
  try {
    await a.actualizar({
      solUsuario: 'USUARIO_FICTICIO',
      solClave: 'CLAVE_FICTICIA',
      regimen: 'por_confirmar',
    });
    const config = await a.configuracion(),
      guardada = await db.sunatConfig.findUnique({ where: { id: 'beta' } });
    assert(config.solClaveConfigurada);
    assert(!JSON.stringify(config).includes('CLAVE_FICTICIA'));
    assert(!guardada.secretos.includes('CLAVE_FICTICIA'));
    assert.equal(config.produccionHabilitada, false);
    await a.actualizar({ nombreComercial: 'PRUEBA' });
    assert((await a.configuracion()).solClaveConfigurada);
    await assert.rejects(() => a.actualizar({ ruc: '12345678' }));
    console.log(
      'ok configuracion privada cifrada, campos omitidos conservan clave y produccion bloqueada',
    );
    const key = randomUUID(),
      result = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? a : b).crear('boleta', key),
        ),
      );
    assert.equal(new Set(result.map((d) => d.id)).size, 1);
    assert.equal(await db.sunatPrueba.count(), 1);
    assert.equal((await db.sunatSeriePrueba.findFirst()).numero, 1);
    await assert.rejects(() => a.crear('factura', key));
    console.log(
      'ok doce solicitudes concurrentes generan un documento y un correlativo',
    );
    await Promise.all([procesarA(), procesarB()]);
    assert.equal(envios, 1);
    const doc = result[0];
    assert.equal((await a.detalle(doc.id)).estado, 'aceptado_beta');
    assert.equal(
      (await a.artefacto(doc.id, 'xml')).buffer.toString(),
      '<XML>PRUEBA FICTICIA</XML>',
    );
    assert((await a.artefacto(doc.id, 'cdr')).buffer.length > 0);
    await assert.rejects(() => a.reintentar(doc.id));
    console.log(
      'ok dos trabajadores toman un solo envio, requieren CDR0 y permiten descargar archivos privados',
    );
    modo = 'timeout';
    const incierto = await a.crear('boleta', randomUUID());
    await procesarA();
    assert.equal((await a.detalle(incierto.id)).estado, 'error_transporte');
    const generados = xmlGenerados;
    const fila = await db.sunatPrueba.findUnique({
      where: { id: incierto.id },
    });
    assert(!fila.xmlCifrado.includes('<XML>'));
    modo = 'aceptado';
    await a.reintentar(incierto.id);
    await procesarA();
    assert.equal(xmlGenerados, generados);
    assert.equal(nombres.at(-1), nombres.at(-2));
    assert.equal((await a.detalle(incierto.id)).intentos, 2);
    console.log(
      'ok timeout conserva XML firmado y reintento reutiliza exactamente el mismo documento',
    );
    modo = 'rechazado';
    const rechazo = await a.crear('factura', randomUUID());
    await procesarA();
    assert.equal((await a.detalle(rechazo.id)).estado, 'rechazado_beta');
    await assert.rejects(() => a.reintentar(rechazo.id));
    console.log(
      'ok CDR de rechazo nunca se etiqueta aceptado ni se reenvia automaticamente',
    );
    const interrumpido = await a.crear('boleta', randomUUID());
    await db.sunatPrueba.update({
      where: { id: interrumpido.id },
      data: {
        estado: 'enviando',
        leaseId: 'otro-proceso',
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    const antesEnvios = envios;
    await procesarB();
    assert.equal(envios, antesEnvios);
    assert.equal((await a.detalle(interrumpido.id)).estado, 'error_transporte');
    assert.deepEqual(await reales(), antes);
    console.log(
      'ok reinicio no duplica envios y ningun ensayo modifica cobros, socios, membresias o series reales',
    );
    const settings = new SettingsService(db);
    await settings.actualizar({ pseToken: 'TOKEN_PSE_FICTICIO' });
    assert.equal((await settings.obtener()).pseToken, 'TOKEN_PSE_FICTICIO');
    assert(
      !JSON.stringify(await settings.administrativo()).includes(
        'TOKEN_PSE_FICTICIO',
      ),
    );
    assert(
      !JSON.stringify(await settings.publico()).includes('TOKEN_PSE_FICTICIO'),
    );
    await settings.actualizar({ pseToken: '' });
    assert.equal((await settings.obtener()).pseToken, 'TOKEN_PSE_FICTICIO');
    console.log(
      'ok token PSE cifrado no vuelve al navegador y el campo vacio lo conserva',
    );
  } finally {
    motor.motorDisponible = originales.disponible;
    motor.ejecutarMotor = originales.motor;
    soap.enviarBeta = originales.enviar;
  }
}
if (require.main === module)
  probarFormatoSunat().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
