/**
 * Datos iniciales: usuarios del personal, los tres planes reales del gimnasio
 * y unos socios de ejemplo para poder probar recepcion y el dashboard.
 *
 *   npx prisma db push && npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

// En produccion (Railway u otro servidor publico) no hay claves de ejemplo ni
// socios inventados: las claves salen de variables de entorno o se generan al
// azar y se imprimen UNA vez en el log del deploy.
const PRODUCCION = process.env.NODE_ENV === 'production';
const CON_EJEMPLOS = !PRODUCCION || process.env.SEED_EJEMPLOS === 'true';

function claveInicial(variable: string, demo: string) {
  const definida = process.env[variable];
  if (definida) return { clave: definida, generada: false };
  if (!PRODUCCION) return { clave: demo, generada: false };
  return { clave: randomBytes(9).toString('base64url'), generada: true };
}

async function crearStaff(email: string, nombre: string, rol: string, variable: string, demo: string) {
  if (await prisma.user.findUnique({ where: { email } })) return;
  const { clave, generada } = claveInicial(variable, demo);
  await prisma.user.create({
    data: { email, nombre, rol, passwordHash: bcrypt.hashSync(clave, 10) },
  });
  if (generada) {
    console.log(`  >> Clave inicial de ${email}: ${clave}  (cambiala en Ajustes > Tu contrasena)`);
  }
}

const TERMINOS = `CONDICIONES DE LA MEMBRESIA

1. Vigencia. La membresia dura la cantidad de dias calendario del plan contratado,
contados desde el dia de inicio indicado en el comprobante. El pase diario vale
unicamente para el dia de su compra.

2. Sin renovacion automatica. La membresia NO se renueva sola ni genera cargos
recurrentes. Vencida, el socio decide si renueva.

3. Renovacion. Si el socio renueva dentro de los 7 dias siguientes al
vencimiento, la nueva membresia arranca el dia siguiente al vencimiento anterior
y no pierde dias. Pasado ese plazo, arranca el dia del pago.

4. Uso personal. La credencial de ingreso es personal e intransferible. Prestarla
faculta al gimnasio a suspender el acceso.

5. Descuento universitario. El precio promocional exige carne universitario
vigente. Al vencer la condicion, aplica la tarifa regular.

6. Horarios. El gimnasio publica sus horarios y puede modificarlos avisando con
anticipacion razonable.

7. Reclamos. El socio puede presentar un reclamo o queja en el Libro de
Reclamaciones, fisico o virtual, y recibira respuesta en un plazo maximo de 15
dias habiles.

REVISAR CON UN ABOGADO ANTES DE PUBLICAR. Este texto es un punto de partida, no
un contrato revisado.`;

const PRIVACIDAD = `POLITICA DE PRIVACIDAD

Responsable del tratamiento: [RAZON SOCIAL], con RUC [RUC] y domicilio en
[DIRECCION], en adelante el gimnasio.

Que datos tratamos. Nombres y apellidos, documento de identidad, telefono,
correo, direccion, fotografia del socio y el registro de sus ingresos y pagos.

Para que. Para administrar la membresia, controlar el acceso al local, emitir
los comprobantes de pago que exige SUNAT y comunicarle vencimientos y avisos del
servicio.

Cuanto tiempo. Mientras dure la relacion con el socio y despues el plazo que
exijan las normas tributarias y contables. Los comprobantes se conservan por
obligacion legal aunque el socio pida la supresion de sus datos.

Con quien se comparten. Con el proveedor de servicios electronicos que emite los
comprobantes ante SUNAT, cuando corresponda. No se venden ni ceden con fines
publicitarios a terceros.

Datos biometricos. El gimnasio no captura huella dactilar salvo consentimiento
expreso y por separado. La fotografia se usa unicamente para verificar en
recepcion que quien ingresa es el titular de la membresia.

Sus derechos. El titular puede acceder a sus datos, rectificarlos, oponerse a su
tratamiento, suprimirlos y revocar su consentimiento, escribiendo a
[CORREO DE CONTACTO] o acercandose a recepcion.

Base legal: Ley 29733, Ley de Proteccion de Datos Personales, y su reglamento
aprobado por DS 016-2024-JUS.

REVISAR CON UN ABOGADO ANTES DE PUBLICAR.`;

const CONSENTIMIENTO = `Autorizo al gimnasio a tratar mis datos personales
(nombres, documento de identidad, telefono, correo, direccion y fotografia) con
la finalidad de administrar mi membresia, controlar mi acceso al local, emitir
los comprobantes de pago correspondientes y enviarme avisos sobre el vencimiento
de mi plan.

Declaro haber sido informado de que puedo acceder, rectificar, oponerme al
tratamiento, suprimir mis datos y revocar este consentimiento en cualquier
momento, y de que los comprobantes de pago se conservan por el plazo que exigen
las normas tributarias.`;


const MS_DIA = 24 * 60 * 60 * 1000;
const hoy = (() => {
  const lima = new Date(Date.now() - 5 * 3600 * 1000);
  return new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate()));
})();
const dias = (d: Date, n: number) => new Date(d.getTime() + n * MS_DIA);

async function main() {
  console.log('Sembrando datos...');

  // Datos del negocio y textos legales. El regimen decide el IGV y si se puede
  // emitir factura: cambiarlo aqui alcanza, no hay que tocar codigo.
  await prisma.settings.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      // Datos reales de la ficha publica del gimnasio. Falta el RUC y la razon
      // social, que solo los tiene el dueno y sin ellos no se emiten boletas.
      razonSocial: 'FORCES GYM',
      nombreComercial: 'FORCES GYM',
      ruc: '',
      direccionFiscal: 'Huascar 22, Pacasmayo, La Libertad',
      telefono: '978223024',
      email: '',
      regimen: 'nrus',
      terminosTexto: TERMINOS,
      privacidadTexto: PRIVACIDAD,
      consentimientoTexto: CONSENTIMIENTO,
    },
  });

  await crearStaff('admin@gimnasio.pe', 'Administrador', 'admin', 'ADMIN_PASSWORD', 'admin123');
  await crearStaff('recepcion@gimnasio.pe', 'Recepcion', 'recepcion', 'RECEPCION_PASSWORD', 'recepcion123');

  const planes = [
    {
      nombre: 'Mensual',
      precio: 100,
      duracionDias: 30,
      orden: 1,
      descripcion: '30 dias calendario de acceso libre',
    },
    {
      nombre: 'Universitario',
      precio: 80,
      duracionDias: 30,
      orden: 2,
      requiereEvidencia: true,
      descripcion: 'Promocion con carne universitario vigente',
    },
    {
      nombre: 'Pase diario',
      precio: 8,
      duracionDias: 1,
      orden: 3,
      descripcion: 'Un solo dia, sin necesidad de registro previo',
    },
  ];

  for (const plan of planes) {
    const existe = await prisma.plan.findFirst({ where: { nombre: plan.nombre } });
    if (!existe) await prisma.plan.create({ data: plan });
  }

  const mensual = await prisma.plan.findFirst({ where: { nombre: 'Mensual' } });
  const universitario = await prisma.plan.findFirst({ where: { nombre: 'Universitario' } });

  const ejemplos = [
    { dni: '70123456', nombres: 'Lucia', apellidos: 'Vasquez Rojas', tel: '987654321', uni: false, iniciaHace: 5, plan: mensual },
    { dni: '71234567', nombres: 'Diego', apellidos: 'Chavez Mendoza', tel: '912345678', uni: true, iniciaHace: 28, plan: universitario },
    { dni: '72345678', nombres: 'Ana', apellidos: 'Quispe Leon', tel: '998877665', uni: false, iniciaHace: 40, plan: mensual },
  ];

  for (const e of CON_EJEMPLOS ? ejemplos : []) {
    if (await prisma.member.findUnique({ where: { dni: e.dni } })) continue;

    const socio = await prisma.member.create({
      data: {
        dni: e.dni,
        nombres: e.nombres,
        apellidos: e.apellidos,
        telefono: e.tel,
        esUniversitario: e.uni,
        pinHash: bcrypt.hashSync(e.dni.slice(-4), 10),
        pinCambiado: true,
        credential: { create: { tipo: 'qr', secret: randomBytes(24).toString('base64url') } },
      },
    });

    const inicio = dias(hoy, -e.iniciaHace);
    await prisma.membership.create({
      data: {
        memberId: socio.id,
        planId: e.plan.id,
        fechaInicio: inicio,
        fechaFin: dias(inicio, e.plan.duracionDias - 1),
        precioPagado: e.plan.precio,
        payments: {
          create: { memberId: socio.id, monto: e.plan.precio, metodo: 'efectivo', fecha: inicio },
        },
      },
    });

    await prisma.consent.create({
      data: {
        memberId: socio.id,
        tipo: 'datos_personales',
        version: '1.0',
        texto: CONSENTIMIENTO,
        origen: 'seed',
      },
    });

    // Visitas de ejemplo: cada una con su entrada y su salida, para que el
    // contador de "dentro ahora" no quede inflado desde el primer arranque.
    for (let d = e.iniciaHace; d > 0; d -= 2) {
      const entrada = new Date(dias(hoy, -d).getTime() + 24 * 3600 * 1000); // 19:00 de Lima
      await prisma.checkIn.create({
        data: {
          memberId: socio.id,
          timestamp: entrada,
          tipo: 'entrada',
          metodo: 'qr',
          resultado: 'permitido',
        },
      });
      await prisma.checkIn.create({
        data: {
          memberId: socio.id,
          timestamp: new Date(entrada.getTime() + 75 * 60 * 1000),
          tipo: 'salida',
          metodo: 'qr',
          resultado: 'permitido',
        },
      });
    }
  }

  const productos = [
    { nombre: 'Agua 625 ml', precio: 2, stock: 48, stockMinimo: 12 },
    { nombre: 'Bebida rehidratante', precio: 4.5, stock: 24, stockMinimo: 6 },
    { nombre: 'Proteina (porcion)', precio: 12, stock: 30, stockMinimo: 8 },
    { nombre: 'Alquiler de casillero', precio: 3, esServicio: true, stock: 0, stockMinimo: 0 },
  ];
  for (const producto of productos) {
    const existe = await prisma.product.findFirst({ where: { nombre: producto.nombre } });
    if (!existe) await prisma.product.create({ data: producto });
  }

  // Catalogo base de ejercicios. El socio puede agregar los suyos desde el portal.
  const ejercicios = [
    ['Press de banca', 'pecho'],
    ['Press inclinado con mancuernas', 'pecho'],
    ['Aperturas en polea', 'pecho'],
    ['Fondos en paralelas', 'pecho'],
    ['Dominadas', 'espalda'],
    ['Remo con barra', 'espalda'],
    ['Jalon al pecho', 'espalda'],
    ['Remo en polea baja', 'espalda'],
    ['Sentadilla', 'pierna'],
    ['Prensa de piernas', 'pierna'],
    ['Peso muerto', 'pierna'],
    ['Extension de cuadriceps', 'pierna'],
    ['Curl femoral', 'pierna'],
    ['Elevacion de pantorrillas', 'pierna'],
    ['Press militar', 'hombro'],
    ['Elevaciones laterales', 'hombro'],
    ['Pajaros', 'hombro'],
    ['Curl de biceps con barra', 'brazo'],
    ['Curl martillo', 'brazo'],
    ['Extension de triceps en polea', 'brazo'],
    ['Press frances', 'brazo'],
    ['Plancha', 'core'],
    ['Abdominales en banco', 'core'],
    ['Rueda abdominal', 'core'],
  ];
  for (const [nombre, grupo] of ejercicios) {
    const existe = await prisma.exercise.findUnique({ where: { nombre } });
    if (!existe) await prisma.exercise.create({ data: { nombre, grupo } });
  }

  console.log('Listo.');
  if (!PRODUCCION) {
    console.log('  Staff:  admin@gimnasio.pe / admin123');
  }
  if (CON_EJEMPLOS) {
    console.log('  Socio:  DNI 70123456, PIN 3456 (solo los de ejemplo; los nuevos reciben un PIN al azar)');
  }
  console.log('');
  console.log('  Falta el RUC del gimnasio en Ajustes para poder emitir boletas.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
