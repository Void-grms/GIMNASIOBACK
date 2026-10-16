import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hoyLima, formatoFecha, rangoDelDia } from '../common/fechas';
import { esRuc } from '../common/validadores';
import { cifrar, descifrar, claveSunat } from './crypto';
import { ejecutarMotor, motorDisponible } from './engine';
import { enviarBeta, leerCdr } from './soap';

const FISCALES = [
  'ruc',
  'razonSocial',
  'nombreComercial',
  'direccionFiscal',
  'ubigeo',
  'departamento',
  'provincia',
  'distrito',
  'regimen',
];
const DEMO = {
  ruc: '20123456789',
  razonSocial: 'EMPRESA FICTICIA DE PRUEBA',
  nombreComercial: 'PRUEBA FORCES GYM',
  direccionFiscal: 'DOMICILIO FICTICIO DE PRUEBA',
  ubigeo: '150101',
  departamento: 'LIMA',
  provincia: 'LIMA',
  distrito: 'LIMA',
  regimen: 'por_confirmar',
};

@Injectable()
export class SunatService {
  private ocupado = false;
  constructor(private prisma: PrismaService) {}
  private leer(row: any) {
    return {
      datos: row ? JSON.parse(row.datos) : {},
      secretos: row?.secretos
        ? JSON.parse(descifrar(row.secretos, 'config'))
        : {},
    };
  }
  private disponible() {
    try {
      claveSunat();
      return true;
    } catch {
      return false;
    }
  }
  async configuracion() {
    const row = await this.prisma.sunatConfig.findUnique({
      where: { id: 'beta' },
    });
    const { datos, secretos } = this.leer(row);
    return {
      entorno: 'beta',
      produccionHabilitada: false,
      perfilPrueba:
        'Operacion ficticia gravada con IGV 18%. No determina el regimen ni los impuestos del gimnasio.',
      ruc: '',
      razonSocial: '',
      nombreComercial: 'FORCES GYM',
      direccionFiscal: '',
      ubigeo: '',
      departamento: '',
      provincia: '',
      distrito: '',
      regimen: 'por_confirmar',
      ...datos,
      solUsuarioConfigurado: !!secretos.solUsuario,
      solClaveConfigurada: !!secretos.solClave,
      certificado: datos.certificado || { configurado: false, esPrueba: true },
      cifradoDisponible: this.disponible(),
      motorDisponible: motorDisponible(),
      pendientesProduccion: [
        'Confirmar regimen y afectacion tributaria con la ficha RUC',
        'Confirmar domicilio fiscal y ubigeo',
        'Verificar certificado y registro en SUNAT',
        'Validar credenciales SOL y permisos de emision',
        'Conciliar series y ultimo correlativo del ERP anterior',
        'Habilitar emision real en una fase posterior, incluyendo anulaciones y notas',
      ],
    };
  }
  async actualizar(dto: Record<string, any>) {
    claveSunat();
    if (Object.values(dto).some((v) => v === null))
      throw new BadRequestException(
        'Completa los campos; no se admiten valores nulos',
      );
    if (
      dto.ruc &&
      (!/^\d{11}$/.test(dto.ruc) ||
        !['10', '20'].includes(dto.ruc.slice(0, 2)) ||
        !esRuc(dto.ruc))
    )
      throw new BadRequestException(
        'El RUC debe tener 11 digitos y ser valido. No uses solamente el DNI.',
      );
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.sunatConfig.upsert({
        where: { id: 'beta' },
        create: { id: 'beta' },
        update: { updatedAt: new Date() },
      });
      const { datos, secretos } = this.leer(row);
      for (const campo of FISCALES)
        if (dto[campo] !== undefined) datos[campo] = dto[campo].trim();
      for (const campo of ['solUsuario', 'solClave'])
        if (dto[campo] !== undefined) secretos[campo] = dto[campo];
      await tx.sunatConfig.update({
        where: { id: 'beta' },
        data: {
          datos: JSON.stringify(datos),
          secretos: cifrar(JSON.stringify(secretos), 'config'),
        },
      });
    });
    return this.configuracion();
  }
  async certificado(pfxBase64: string, password: string) {
    claveSunat();
    if (
      !/^[A-Za-z0-9+/=]+$/.test(pfxBase64) ||
      Buffer.from(pfxBase64, 'base64').length > 1_000_000
    )
      throw new BadRequestException(
        'Usa un certificado PFX o P12 de hasta 1 MB',
      );
    let inspected: any;
    try {
      inspected = await ejecutarMotor({
        action: 'inspectCertificate',
        certificadoPfxBase64: pfxBase64,
        certificadoPassword: password,
      });
    } catch {
      throw new BadRequestException(
        'No se pudo abrir el certificado. Revisa el archivo, la clave y su vigencia.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.sunatConfig.upsert({
        where: { id: 'beta' },
        create: { id: 'beta' },
        update: { updatedAt: new Date() },
      });
      const { datos, secretos } = this.leer(row);
      datos.certificado = { configurado: true, ...inspected.certificado };
      secretos.certificadoPfxBase64 = pfxBase64;
      secretos.certificadoPassword = password;
      await tx.sunatConfig.update({
        where: { id: 'beta' },
        data: {
          datos: JSON.stringify(datos),
          secretos: cifrar(JSON.stringify(secretos), 'config'),
        },
      });
    });
    return this.configuracion();
  }
  async quitarCertificado() {
    claveSunat();
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.sunatConfig.upsert({
        where: { id: 'beta' },
        create: { id: 'beta' },
        update: { updatedAt: new Date() },
      });
      const { datos, secretos } = this.leer(row);
      delete secretos.certificadoPfxBase64;
      delete secretos.certificadoPassword;
      delete datos.certificado;
      await tx.sunatConfig.update({
        where: { id: 'beta' },
        data: {
          datos: JSON.stringify(datos),
          secretos: cifrar(JSON.stringify(secretos), 'config'),
        },
      });
    });
    return this.configuracion();
  }
  private vista(d: any) {
    return {
      id: d.id,
      tipo: d.tipo,
      entorno: 'beta',
      ruc: d.ruc,
      serie: d.serie,
      numero: d.numero,
      estado: d.estado,
      total: 60,
      gravado: 50.85,
      igv: 9.15,
      mensaje: d.mensaje,
      codigo: d.codigo,
      ticket: d.ticket,
      hash: d.hash,
      emitidoAt: d.emitidoAt,
      actualizadoAt: d.actualizadoAt,
      tieneXml: !!d.xmlCifrado,
      tieneCdr: !!d.cdrCifrado,
      intentos: d.intentos,
      esPrueba: true,
    };
  }
  async listar() {
    return (
      await this.prisma.sunatPrueba.findMany({
        orderBy: { emitidoAt: 'desc' },
        take: 100,
      })
    ).map((d) => this.vista(d));
  }
  private async documento(id: string) {
    const d = await this.prisma.sunatPrueba.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Prueba no encontrada');
    return d;
  }
  async detalle(id: string) {
    return this.vista(await this.documento(id));
  }
  async crear(tipo: string, key: string) {
    claveSunat();
    if (!motorDisponible())
      throw new ServiceUnavailableException(
        'El motor de firma no esta instalado en este servidor',
      );
    const prev = await this.prisma.sunatPrueba.findUnique({
      where: { idempotencyKey: key },
    });
    if (prev) {
      if (prev.tipo !== tipo)
        throw new ConflictException(
          'Ese intento pertenece a otro tipo de comprobante',
        );
      return this.vista(prev);
    }
    let doc: any;
    try {
      doc = await this.prisma.$transaction(
        async (tx) => {
          const config = await tx.sunatConfig.upsert({
            where: { id: 'beta' },
            create: { id: 'beta' },
            update: { updatedAt: new Date() },
          });
          const { datos, secretos } = this.leer(config);
          const emisor = datos.ruc ? datos : DEMO;
          if (
            datos.ruc &&
            [
              'razonSocial',
              'direccionFiscal',
              'ubigeo',
              'departamento',
              'provincia',
              'distrito',
            ].some((k) => !datos[k]?.trim())
          )
            throw new BadRequestException(
              'Completa el domicilio fiscal, ubigeo y razon social para probar con tu RUC, o usa el emisor ficticio.',
            );
          const repeat = await tx.sunatPrueba.findUnique({
            where: { idempotencyKey: key },
          });
          if (repeat) {
            if (repeat.tipo !== tipo)
              throw new ConflictException('Ese intento pertenece a otro tipo');
            return repeat;
          }
          if (
            (await tx.sunatPrueba.count({
              where: { emitidoAt: { gte: rangoDelDia(hoyLima()).inicio } },
            })) >= 100
          )
            throw new BadRequestException(
              'Limite de 100 ensayos diarios. Conserva y revisa las pruebas existentes.',
            );
          const serie = await tx.sunatSeriePrueba.upsert({
            where: { ruc_tipo: { ruc: emisor.ruc, tipo } },
            create: { ruc: emisor.ruc, tipo, numero: 1 },
            update: { numero: { increment: 1 } },
          });
          if (serie.numero > 99999999)
            throw new BadRequestException('Correlativo de ensayo agotado');
          const id = randomUUID();
          const snapshot = {
            ...Object.fromEntries(FISCALES.map((k) => [k, emisor[k]])),
            fecha: formatoFecha(hoyLima()),
            certificadoCifrado: secretos.certificadoPfxBase64
              ? cifrar(
                  JSON.stringify({
                    certificadoPfxBase64: secretos.certificadoPfxBase64,
                    certificadoPassword: secretos.certificadoPassword,
                  }),
                  'cert:' + id,
                )
              : null,
          };
          return tx.sunatPrueba.create({
            data: {
              id,
              idempotencyKey: key,
              ruc: emisor.ruc,
              tipo,
              serie: tipo === 'boleta' ? 'BTE1' : 'FTE1',
              numero: serie.numero,
              snapshot: JSON.stringify(snapshot),
              mensaje:
                'Ensayo creado. No registra pago ni consume numeracion real.',
            },
          });
        },
        { maxWait: 10000, timeout: 10000 },
      );
    } catch (e) {
      if (e?.code === 'P2002') {
        const d = await this.prisma.sunatPrueba.findUnique({
          where: { idempotencyKey: key },
        });
        if (d && d.tipo === tipo) return this.vista(d);
      }
      throw e;
    }
    // La respuesta no depende de la disponibilidad de SUNAT. El trabajo persiste.
    void this.procesar().catch(() => {});
    return this.vista(doc);
  }
  async reintentar(id: string, consultar = false) {
    const d = await this.documento(id);
    if (consultar && !d.ticket)
      throw new BadRequestException(
        'Este envio individual no tiene ticket. Revisa el CDR o el error del mismo documento.',
      );
    if (!['error_transporte', 'pendiente_ticket'].includes(d.estado))
      throw new BadRequestException(
        'Solo se reintenta un envio sin resultado definitivo. Un rechazo exige revisar una nueva prueba.',
      );
    await this.prisma.sunatPrueba.updateMany({
      where: { id, estado: d.estado, leaseId: null },
      data: {
        estado: 'creado',
        mensaje: 'Reintentando el mismo documento y correlativo.',
      },
    });
    void this.procesar().catch(() => {});
    return this.detalle(id);
  }
  @Cron('*/15 * * * * *')
  async procesar() {
    if (this.ocupado || !this.disponible() || !motorDisponible()) return;
    this.ocupado = true;
    try {
      // Un proceso interrumpido no se reenvia automaticamente: el resultado de red puede ser incierto.
      await this.prisma.sunatPrueba.updateMany({
        where: { estado: 'enviando', leaseUntil: { lt: new Date() } },
        data: {
          estado: 'error_transporte',
          leaseId: null,
          leaseUntil: null,
          mensaje:
            'El envio se interrumpio. Verifica o reintenta este mismo documento; no crees otro para sustituirlo.',
        },
      });
      const candidate = await this.prisma.sunatPrueba.findFirst({
        where: { estado: 'creado' },
        orderBy: { emitidoAt: 'asc' },
      });
      if (!candidate) return;
      const lease = randomUUID();
      const taken = await this.prisma.sunatPrueba.updateMany({
        where: { id: candidate.id, estado: 'creado' },
        data: {
          estado: 'enviando',
          leaseId: lease,
          leaseUntil: new Date(Date.now() + 90000),
          intentos: { increment: 1 },
        },
      });
      if (!taken.count) return;
      const update = (data: any) =>
        this.prisma.sunatPrueba.updateMany({
          where: { id: candidate.id, leaseId: lease, estado: 'enviando' },
          data,
        });
      try {
        const s = JSON.parse(candidate.snapshot);
        const nombre = `${candidate.ruc}-${candidate.tipo === 'boleta' ? '03' : '01'}-${candidate.serie}-${candidate.numero}`;
        let xml = candidate.xmlCifrado
          ? descifrar(candidate.xmlCifrado, 'xml:' + candidate.id)
          : null;
        if (!xml) {
          const cert = s.certificadoCifrado
            ? JSON.parse(
                descifrar(s.certificadoCifrado, 'cert:' + candidate.id),
              )
            : {};
          const result = await ejecutarMotor({
            action: 'generate',
            ...cert,
            documento: {
              ...s,
              direccion: s.direccionFiscal,
              tipo: candidate.tipo === 'boleta' ? '03' : '01',
              serie: candidate.serie,
              numero: candidate.numero,
              items: [
                {
                  descripcion:
                    'PRUEBA SIN VALIDEZ TRIBUTARIA - SERVICIO FICTICIO',
                  cantidad: 1,
                  precioUnitarioCentimos: 6000,
                  afectacion: '10',
                },
              ],
            },
          });
          if (
            result.nombreArchivo !== nombre ||
            result.firmaVerificada !== true ||
            typeof result.xmlBase64 !== 'string'
          )
            throw new Error('Firma no confirmada');
          xml = Buffer.from(result.xmlBase64, 'base64').toString('utf8');
          if (Buffer.byteLength(xml) > 1_000_000)
            throw new Error('XML demasiado grande');
          await update({
            xmlCifrado: cifrar(xml, 'xml:' + candidate.id),
            hash: String(result.hash).slice(0, 200),
          });
        }
        const respuesta = await enviarBeta(
          candidate.ruc,
          nombre,
          xml,
          candidate.ticket || undefined,
        );
        if (respuesta.cdr) {
          const cdr = await leerCdr(respuesta.cdr, nombre);
          await update({
            estado: cdr.aceptado ? 'aceptado_beta' : 'rechazado_beta',
            codigo: cdr.codigo,
            mensaje: cdr.mensaje,
            cdrCifrado: cifrar(cdr.base64, 'cdr:' + candidate.id),
            leaseId: null,
            leaseUntil: null,
          });
        } else if (respuesta.fallo) {
          await update({
            estado:
              Number(respuesta.codigo) >= 2000
                ? 'rechazado_beta'
                : 'error_transporte',
            codigo: respuesta.codigo,
            mensaje: 'SUNAT BETA: ' + respuesta.fallo,
            leaseId: null,
            leaseUntil: null,
          });
        } else if (respuesta.ticket) {
          await update({
            estado: 'pendiente_ticket',
            ticket: respuesta.ticket,
            mensaje: 'Ticket recibido; aun no hay constancia de aceptacion.',
            leaseId: null,
            leaseUntil: null,
          });
        } else if (respuesta.codigo === '98') {
          await update({
            estado: 'pendiente_ticket',
            mensaje: 'SUNAT BETA sigue procesando el ticket.',
            leaseId: null,
            leaseUntil: null,
          });
        } else throw new Error('Sin constancia verificable');
      } catch {
        await update({
          estado: 'error_transporte',
          mensaje:
            'No se obtuvo una constancia verificable de SUNAT BETA. Puede ser un problema de conexion, respuesta o firma. El XML existente y su correlativo se conservan para revisar y reintentar.',
          leaseId: null,
          leaseUntil: null,
        });
      }
    } finally {
      this.ocupado = false;
    }
  }
  async artefacto(id: string, tipo: string) {
    const d = await this.documento(id);
    const contenido = tipo === 'xml' ? d.xmlCifrado : d.cdrCifrado;
    if (!contenido)
      throw new NotFoundException('El archivo aun no esta disponible');
    const nombre = `${d.ruc}-${d.tipo === 'boleta' ? '03' : '01'}-${d.serie}-${d.numero}`;
    return {
      buffer:
        tipo === 'xml'
          ? Buffer.from(descifrar(contenido, 'xml:' + id), 'utf8')
          : Buffer.from(descifrar(contenido, 'cdr:' + id), 'base64'),
      nombre:
        (tipo === 'xml' ? nombre : `R-${nombre}`) +
        (tipo === 'xml' ? '.xml' : '.zip'),
    };
  }
}
