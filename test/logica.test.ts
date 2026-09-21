/**
 * Pruebas de la logica que no se puede equivocar: el calculo de vencimientos
 * y la credencial QR rotativa. No tocan la base de datos.
 *
 *   npm run test:logica
 */
import {
  fechaFinDe,
  diasRestantes,
  inicioDeNuevaMembresia,
  formatoFecha,
  hoyLima,
  sumarDias,
  rangoDelDia,
  rangoEntre,
  diaLimaDe,
  fechaDesdeTexto,
} from '../src/common/fechas';
import { QrService } from '../src/qr/qr.service';
import { ReceiptsService } from '../src/receipts/receipts.service';
import { esDni, esRuc, esCelular, esDocumentoValido, esMonto } from '../src/common/validadores';
import { sumarDiasHabiles } from '../src/common/fechas';

let fallos = 0;
const ok = (nombre: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FALLA'} ${nombre}${extra ? '  -> ' + extra : ''}`);
  if (!cond) fallos++;
};

console.log('\nVencimientos');
const inicio = new Date(Date.UTC(2026, 8, 19)); // 19 set 2026
ok('30 dias desde el 19 set vencen el 18 oct', formatoFecha(fechaFinDe(inicio, 30)) === '2026-10-18');
ok('el pase diario empieza y termina el mismo dia', formatoFecha(fechaFinDe(inicio, 1)) === '2026-09-19');

const hoy = hoyLima();
const venceEn3 = sumarDias(hoy, 3);
const vencioHace2 = sumarDias(hoy, -2);
const vencioHace60 = sumarDias(hoy, -60);

ok(
  'renovar antes de vencer arranca el dia siguiente al vencimiento',
  formatoFecha(inicioDeNuevaMembresia(venceEn3, 7)) === formatoFecha(sumarDias(hoy, 4)),
);
ok(
  'renovar con 2 dias de atraso no le quita dias al socio',
  formatoFecha(inicioDeNuevaMembresia(vencioHace2, 7)) === formatoFecha(sumarDias(hoy, -1)),
);
ok(
  'pasados los dias de gracia la nueva membresia arranca hoy',
  formatoFecha(inicioDeNuevaMembresia(vencioHace60, 7)) === formatoFecha(hoy),
);
ok('un socio nuevo arranca hoy', formatoFecha(inicioDeNuevaMembresia(null, 7)) === formatoFecha(hoy));

console.log('\nDias de Lima contra UTC');
const dia = new Date(Date.UTC(2026, 8, 19));
const { inicio: iniDia, fin: finDia } = rangoDelDia(dia);
ok(
  'el dia de Lima empieza a las 05:00 UTC',
  iniDia.toISOString() === '2026-09-19T05:00:00.000Z',
  iniDia.toISOString(),
);
ok('y termina 24 horas despues', finDia.toISOString() === '2026-09-20T05:00:00.000Z');
ok(
  'un cobro de las 21:00 de Lima cuenta para ese mismo dia',
  (() => {
    const cobro = new Date('2026-09-20T02:00:00.000Z'); // 21:00 del 19 en Lima
    return cobro >= iniDia && cobro < finDia;
  })(),
);
ok(
  'un ingreso de las 20:00 de Lima pertenece a ese dia, no al siguiente',
  diaLimaDe(new Date('2026-09-20T01:00:00.000Z')) === '2026-09-19',
  diaLimaDe(new Date('2026-09-20T01:00:00.000Z')),
);
ok(
  'un rango de varios dias llega hasta el final del ultimo',
  rangoEntre(dia, sumarDias(dia, 2)).fin.toISOString() === '2026-09-22T05:00:00.000Z',
);
ok('una fecha en texto se lee bien', formatoFecha(fechaDesdeTexto('2026-09-19')) === '2026-09-19');
ok('un texto invalido cae en hoy', formatoFecha(fechaDesdeTexto('basura')) === formatoFecha(hoyLima()));

console.log('\nSemaforo de recepcion');
ok('vence hoy => 0 dias restantes', diasRestantes(hoy) === 0);
ok('vence en 3 dias => 3', diasRestantes(venceEn3) === 3);
ok('vencio hace 2 dias => -2', diasRestantes(vencioHace2) === -2);

console.log('\nCredencial QR');
const qr = new QrService();
const secreto = qr.nuevoSecreto();
const memberId = 'clsocioejemplo01';
const ahora = new Date();
const { codigo } = qr.generar(memberId, secreto, ahora);

ok('el codigo valida contra el secreto del socio', qr.validar(codigo, secreto, ahora));
ok('recepcion puede leer de que socio es', qr.leerMemberId(codigo) === memberId);
ok('con otro secreto no valida', !qr.validar(codigo, qr.nuevoSecreto(), ahora));
ok('un codigo alterado no valida', !qr.validar(codigo.slice(0, -1) + 'X', secreto, ahora));
ok('tolera 30 segundos de desfase de reloj', qr.validar(codigo, secreto, new Date(ahora.getTime() + 30_000)));
ok(
  'una captura de pantalla de hace 3 minutos ya no sirve',
  !qr.validar(codigo, secreto, new Date(ahora.getTime() + 180_000)),
);
ok('texto basura no revienta la validacion', !qr.validar('hola', secreto, ahora));
ok('un DNI no se confunde con un QR', qr.leerMemberId('70123456') === null);

console.log('\nDocumentos peruanos');
ok('DNI de 8 digitos vale', esDni('70123456'));
ok('DNI de 7 digitos no vale', !esDni('7012345'));
ok('DNI con letras no vale', !esDni('7012345A'));

// 20131312955 es el RUC de SUNAT, publico y facil de contrastar.
ok('RUC real valida', esRuc('20131312955'));
ok('un digito cambiado invalida el RUC', !esRuc('20131312956'));
ok('RUC de 10 digitos no vale', !esRuc('2013131295'));
ok('prefijo invalido no vale', !esRuc('99131312955'));
ok('RUC con espacios y guiones igual valida', esRuc('20-131312955'));

ok('celular 9 digitos que empieza en 9', esCelular('987654321'));
ok('celular que no empieza en 9 no vale', !esCelular('887654321'));
ok('fijo de 7 digitos no pasa como celular', !esCelular('4441234'));

ok('sin documento siempre pasa', esDocumentoValido('sin_documento'));
ok('factura con RUC malo no pasa', !esDocumentoValido('ruc', '20131312956'));
ok('tipo desconocido no pasa', !esDocumentoValido('licencia', '123'));

ok('monto con 2 decimales vale', esMonto(84.75));
ok('monto negativo no vale', !esMonto(-10));
ok('monto con 3 decimales no vale', !esMonto(10.123));

console.log('\nDesglose del IGV');
const recibos = new ReceiptsService(null as any, null as any, null as any);
const conIgv = recibos.desglosar(100, true, 0.18);
ok('S/ 100 con IGV incluido = 84.75 + 15.25', conIgv.gravado === 84.75 && conIgv.igv === 15.25,
   `${conIgv.gravado} + ${conIgv.igv}`);
ok('las partes suman el total', conIgv.gravado + conIgv.igv === 100);
const sinIgv = recibos.desglosar(100, false, 0.18);
ok('en NRUS todo va como inafecto', sinIgv.inafecto === 100 && sinIgv.igv === 0);
const paseDiario = recibos.desglosar(8, true, 0.18);
ok('el pase diario tambien cuadra', paseDiario.gravado + paseDiario.igv === 8,
   `${paseDiario.gravado} + ${paseDiario.igv}`);

console.log('\nPlazo de 15 dias habiles del libro de reclamaciones');
const viernes = new Date(Date.UTC(2026, 8, 18)); // viernes 18 set 2026
ok('un dia habil despues del viernes es lunes',
   formatoFecha(sumarDiasHabiles(viernes, 1)) === '2026-09-21',
   formatoFecha(sumarDiasHabiles(viernes, 1)));
ok('15 dias habiles caen en dia de semana',
   [1, 2, 3, 4, 5].includes(sumarDiasHabiles(viernes, 15).getUTCDay()));
ok('15 dias habiles son mas que 15 corridos',
   sumarDiasHabiles(viernes, 15).getTime() > sumarDias(viernes, 15).getTime());
const antesDeFiestasPatrias = new Date(Date.UTC(2026, 6, 27)); // lunes 27 jul
ok('el 28 y 29 de julio no cuentan como habiles',
   formatoFecha(sumarDiasHabiles(antesDeFiestasPatrias, 1)) === '2026-07-30',
   formatoFecha(sumarDiasHabiles(antesDeFiestasPatrias, 1)));

console.log(fallos === 0 ? '\nTodo correcto.\n' : `\n${fallos} prueba(s) fallaron.\n`);
process.exit(fallos === 0 ? 0 : 1);
