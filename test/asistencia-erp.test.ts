import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { CheckinsService } from '../src/checkins/checkins.service';
import { QrService } from '../src/qr/qr.service';
import { hoyLima, sumarDias } from '../src/common/fechas';

async function probar() {
  const hoy = hoyLima();
  const socios = [
    { id: 'migrado', codigoERP: '1277', dni: null, activo: true },
    { id: 'ceros', codigoERP: '0012', dni: '70000001', activo: true },
    { id: 'vencido', codigoERP: '98', dni: '70000002', activo: true },
    { id: 'baja', codigoERP: '99', dni: '70000003', activo: false },
    { id: 'ambiguo-erp', codigoERP: '70000004', dni: '70000005', activo: true },
    { id: 'ambiguo-dni', codigoERP: '123', dni: '70000004', activo: true },
  ];
  const membresias = new Map(socios.map(s => [s.id, {
    id: `plan-${s.id}`, estado: 'activa',
    fechaInicio: sumarDias(hoy, -10),
    fechaFin: sumarDias(hoy, s.id === 'vencido' ? -1 : 10),
  }]));
  const movimientos: any[] = [];
  const qr = new QrService();
  const secreto = qr.nuevoSecreto();
  const coincide = (s: any, where: any): boolean => where.OR
    ? where.OR.some((f: any) => coincide(s, f))
    : Object.entries(where).every(([k, v]) => s[k] === v);
  const prisma: any = {
    member: {
      findMany: async ({ where }: any) => socios.filter(s => coincide(s, where)),
      findUnique: async ({ where }: any) => socios.find(s => s.id === where.id) || null,
      updateMany: async ({ where, data }: any) => {
        assert.equal(data.portalVersion.increment, 0, 'El lock no revoca sesiones del portal');
        return { count: socios.some(s => s.id === where.id) ? 1 : 0 };
      },
    },
    membership: { findFirst: async ({ where }: any) => membresias.get(where.memberId) || null },
    credential: { findUnique: async () => ({ activo: true, secret: secreto, member: socios[1] }) },
    checkIn: {
      findFirst: async ({ where }: any) => movimientos.filter(m => m.memberId === where.memberId && m.resultado === 'permitido').at(-1) || null,
      create: async ({ data }: any) => {
        const registro = { ...data, id: `mov-${movimientos.length}`, timestamp: new Date() };
        movimientos.push(registro);
        return registro;
      },
    },
    locker: { findUnique: async () => null },
  };
  prisma.$transaction = async (trabajo: any) => trabajo(prisma);
  const members: any = {
    membresiaVigente: async (id: string) => membresias.get(id) || null,
    resumen: (s: any, m: any, dentro: boolean) => ({ id: s.id, codigoERP: s.codigoERP, dni: s.dni, dentro }),
  };
  const service = new CheckinsService(prisma, members, qr);

  const migrado = await service.escanear('1277', 'recepcion');
  assert.equal(migrado.resultado, 'permitido');
  assert.equal(migrado.socio.id, 'migrado');
  assert.equal(movimientos[0].metodo, 'erp');
  assert.equal(movimientos[0].tipo, 'entrada');
  // La cuenta sin DNI ni activación conserva la asistencia, sin regalar acceso al portal.
  assert.equal(migrado.socio.dni, null);
  const repetido = await service.escanear('1277');
  assert.equal(repetido.resultado, 'repetido');
  assert.equal(movimientos.length, 1);
  movimientos[0].timestamp = new Date(Date.now() - 5 * 60_000);
  const salida = await service.escanear('ERP:1277');
  assert.equal(salida.tipo, 'salida');
  assert.equal(salida.resultado, 'permitido');

  assert.equal((await service.escanear('12')).resultado, 'denegado');
  assert.equal((await service.escanear('0012')).socio.id, 'ceros');
  assert.equal((await service.escanear('70000001')).socio.id, 'ceros');
  assert.equal((await service.escanear('DNI:70000001')).socio.id, 'ceros');
  assert.equal((await service.escanear('98')).resultado, 'denegado');
  assert.match((await service.escanear('98')).motivo!, /vencida/);
  assert.match((await service.escanear('99')).motivo!, /baja/);
  const ambiguo = await service.escanear('70000004');
  assert.equal(ambiguo.resultado, 'denegado');
  assert.equal(ambiguo.socio, null);
  assert.equal((await service.escanear('ERP:70000004')).socio.id, 'ambiguo-erp');
  assert.equal((await service.escanear('DNI:70000004')).socio.id, 'ambiguo-dni');
  assert.equal((await service.escanear('letras70000001')).resultado, 'denegado');
  assert.equal((await service.escanear('DNI:1277')).resultado, 'denegado');

  const codigoQr = qr.generar('ceros', secreto).codigo;
  assert.equal((await service.escanear(codigoQr)).socio.id, 'ceros');
  const qrVencido = qr.generar('ceros', secreto, new Date(Date.now() - 180_000)).codigo;
  assert.equal((await service.escanear(qrVencido)).resultado, 'denegado');

  let intentosTimeout = 0;
  const saturado = new CheckinsService({ $transaction: async () => {
    intentosTimeout++;
    throw Object.assign(new Error('Timeout simulado de transaccion'), { code: 'P2028' });
  } } as any, members, qr);
  await assert.rejects(() => saturado.registrar(socios[0], 'erp'), (error: any) => error instanceof ServiceUnavailableException && error.getStatus() === 503);
  assert.equal(intentosTimeout, 1, 'Un timeout P2028 responde 503 sin reintentar una transaccion de resultado incierto');
  console.log('Asistencia ERP: identificadores, ceros, ambigüedad, membresía, baja, QR, rebote y timeout503 correctos.');
}

probar().catch(error => { console.error(error); process.exitCode = 1; });
