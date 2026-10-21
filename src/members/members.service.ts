import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { hashPassword } from '../common/password';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { SettingsService } from '../settings/settings.service';
import { diasRestantes, formatoFecha, hoyLima } from '../common/fechas';
import { carpetaArchivos, esPostgres } from '../common/archivos';
import { DURACION_ACCESO_MS, consentimientoPendiente, estadoPortal, pinAleatorio, sinSecretos, validarDniPortal } from './acceso.util';
import { conPlanContratado } from '../plans/condiciones';
import { cuentaDe, elegirMembresia, pausaActual } from '../memberships/cuenta.util';

export type EstadoSocio = 'vigente' | 'por_vencer' | 'vencido' | 'sin_membresia';

@Injectable()
export class MembersService {
  /** Dias antes del vencimiento en que la pantalla pasa a ambar. */
  private readonly AVISO_DIAS = 3;

  constructor(
    private prisma: PrismaService,
    private qr: QrService,
    private settings: SettingsService,
  ) {}

  async crear(dto: {
    dni: string;
    nombres: string;
    apellidos: string;
    telefono?: string;
    email?: string;
    fotoUrl?: string;
    direccion?: string;
    esUniversitario?: boolean;
    notas?: string;
    codigoERP?: string;
    consentimiento?: boolean;
  }) {
    const dni = validarDniPortal(dto.dni);
    const codigoERP = this.codigoERP(dto.codigoERP);

    const repetido = await this.prisma.member.findUnique({ where: { dni } });
    if (repetido) throw new BadRequestException(`Ya existe un socio con el DNI ${dni}`);

    // Sin consentimiento expreso no se puede tratar el dato: el DS 016-2024-JUS
    // pide que sea expreso, especifico e informado, no una casilla marcada sola.
    if (!dto.consentimiento) {
      throw new BadRequestException(
        'Falta el consentimiento del socio para el tratamiento de sus datos personales',
      );
    }

    // El PIN se genera al azar, no se deriva del DNI: quien conoce el documento
    // no debe poder entrar al portal del socio. Recepcion lo entrega una vez y
    // el portal obliga a cambiarlo en el primer ingreso.
    const pin = pinAleatorio(dni, codigoERP);
    const pinTemporalHasta = new Date(Date.now() + DURACION_ACCESO_MS);
    const ajustes = await this.settings.obtener();
    if (codigoERP && await this.prisma.member.findUnique({ where: { codigoERP } })) {
      throw new BadRequestException('El codigo ERP ya pertenece a otro socio');
    }

    const socio = await this.prisma.member.create({
      data: {
        dni,
        codigoERP,
        nombres: dto.nombres.trim(),
        apellidos: dto.apellidos.trim(),
        telefono: dto.telefono?.trim() || null,
        email: dto.email?.trim().toLowerCase() || null,
        fotoUrl: dto.fotoUrl || null,
        direccion: dto.direccion?.trim() || null,
        esUniversitario: !!dto.esUniversitario,
        notas: dto.notas || null,
        pinHash: await hashPassword(pin),
        pinCambiado: false,
        pinTemporalHasta,
        credential: { create: { tipo: 'qr', secret: this.qr.nuevoSecreto() } },
        consents: { create: { tipo: 'datos_personales', version: ajustes.consentimientoVersion, texto: ajustes.consentimientoTexto, origen: 'recepcion', aceptado: true } },
      },
      include: { consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1 } },
    });

    // El PIN en claro viaja una sola vez, en esta respuesta, para que recepcion
    // se lo entregue al socio. No se guarda en ningun lado.
    return { ...sinSecretos(socio), ...this.resumen(socio, null), pinInicial: pin, vence: pinTemporalHasta.toISOString() };
  }

  private codigoERP(valor?: string): string | null {
    if (valor === undefined || valor === null || valor.trim() === '') return null;
    const codigo = valor.trim();
    if (!/^\d{1,20}$/.test(codigo)) throw new BadRequestException('El codigo ERP debe contener entre 1 y 20 digitos');
    return codigo;
  }

  /**
   * Deja constancia de a que texto y a que version consintio el socio. Probar
   * que consintio no sirve de nada si no se sabe a que consintio.
   */
  async registrarConsentimiento(memberId: string, tipo: string, origen: string, ip?: string) {
    const ajustes = await this.settings.obtener();
    const texto =
      tipo === 'terminos'
        ? ajustes.terminosTexto
        : tipo === 'datos_personales'
          ? ajustes.consentimientoTexto
          : '';
    const version =
      tipo === 'terminos' ? ajustes.terminosVersion : ajustes.consentimientoVersion;

    return this.prisma.consent.create({
      data: { memberId, tipo, version, texto, origen, ip: ip || null, aceptado: true },
    });
  }

  async actualizar(id: string, dto: Record<string, any>) {
    const previo = await this.prisma.member.findUnique({ where: { id } });
    if (!previo) throw new NotFoundException('Socio no encontrado');
    if (dto.pin !== undefined) throw new BadRequestException('Usa la opcion de PIN temporal para restablecer el acceso');
    if (['dni', 'telefono', 'codigoERP'].some((campo) => dto[campo] !== undefined) && dto.identidadVerificada !== true) {
      throw new BadRequestException('Recepcion debe verificar la identidad antes de modificar DNI, telefono o codigo ERP');
    }
    const data: Record<string, any> = {};
    for (const campo of ['nombres', 'apellidos', 'telefono', 'email', 'fotoUrl', 'notas']) {
      if (dto[campo] !== undefined) data[campo] = dto[campo];
    }
    if (dto.esUniversitario !== undefined) data.esUniversitario = !!dto.esUniversitario;
    if (dto.activo !== undefined) data.activo = !!dto.activo;
    if (dto.dni !== undefined) {
      data.dni = validarDniPortal(dto.dni);
      const existe = await this.prisma.member.findUnique({ where: { dni: data.dni } });
      if (existe && existe.id !== id) throw new BadRequestException('El DNI ya pertenece a otro socio');
    }
    if (dto.codigoERP !== undefined) {
      data.codigoERP = this.codigoERP(dto.codigoERP);
      if (data.codigoERP) {
        const existe = await this.prisma.member.findUnique({ where: { codigoERP: data.codigoERP } });
        if (existe && existe.id !== id) throw new BadRequestException('El codigo ERP ya pertenece a otro socio');
      }
    }
    const revocar = ['dni', 'telefono', 'codigoERP', 'activo'].some((campo) => data[campo] !== undefined && data[campo] !== previo[campo]);
    if (revocar) data.portalVersion = { increment: 1 };
    if (data.activo === false) Object.assign(data, { pinHash: await hashPassword(pinAleatorio()), pinCambiado: false, pinTemporalHasta: null });
    const socio = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.member.update({ where: { id }, data, include: { consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1 } } });
      if (revocar) await tx.portalActivation.updateMany({ where: { memberId: id, usedAt: null }, data: { usedAt: new Date() } });
      return actualizado;
    });
    return { ...sinSecretos(socio), ...this.resumen(socio, null) };
  }

  async buscar(q?: string, limite = 50) {
    const texto = (q || '').trim();
    // En SQLite `contains` ya ignora mayusculas; en PostgreSQL hay que pedirlo.
    // El cliente generado para SQLite no conoce `mode`, de ahi el cast.
    const sinMayus = (esPostgres() ? { mode: 'insensitive' } : {}) as {};
    const socios = await this.prisma.member.findMany({
      where: texto
        ? {
            OR: [
              { dni: { contains: texto } },
              { codigoERP: { contains: texto } },
              { nombres: { contains: texto, ...sinMayus } },
              { apellidos: { contains: texto, ...sinMayus } },
            ],
          }
        : undefined,
      orderBy: [{ apellidos: 'asc' }, { nombres: 'asc' }],
      take: limite,
      include: { memberships: { where: { estado: { in: ['activa', 'vencida'] } }, orderBy: [{ createdAt: 'desc' }, { fechaFin: 'desc' }], include: { plan: true, congelamientos: true, payments: { select: { monto: true, montoCentimos: true } } } }, consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1, select: { tipo: true, aceptado: true } } },
    });
    const hoy = hoyLima();
    return socios.map((s) => this.resumen(s, elegirMembresia(s.memberships, hoy)));
  }

  /** Membresia con la fecha de fin mas lejana que no este anulada. */
  async membresiaVigente(memberId: string) {
    const hoy = hoyLima();
    const lista = await this.prisma.membership.findMany({ where: { memberId, estado: { in: ['activa', 'vencida'] } }, orderBy: [{ createdAt: 'desc' }, { fechaFin: 'desc' }, { id: 'desc' }], include: { plan: true, congelamientos: true, payments: { select: { monto: true, montoCentimos: true } } } });
    return elegirMembresia(lista, hoy);
  }

  async obtener(id: string) {
    const socio = await this.prisma.member.findUnique({
      where: { id },
      include: {
        memberships: {
          orderBy: { fechaInicio: 'desc' },
          include: { plan: true, congelamientos: { orderBy: { desde: 'asc' } }, operaciones: { orderBy: { createdAt: 'desc' } }, payments: { orderBy: { fecha: 'desc' }, include: { cajero: { select: { nombre: true } }, receipt: true } } },
        },
        payments: { orderBy: { fecha: 'desc' }, take: 20 },
        checkIns: { orderBy: { timestamp: 'desc' }, take: 20 },
        consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1 },
      },
    });
    if (!socio) throw new NotFoundException('Socio no encontrado');
    const hoy = hoyLima();
    const vigente = elegirMembresia([...socio.memberships].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()), hoy);
    const historial = socio.memberships.map(m => ({ ...conPlanContratado(m), cuenta: cuentaDe(m) }));
    return {
      ...this.resumen(socio, vigente, await this.estaDentro(id)),
      socio: { ...sinSecretos(socio), memberships: historial, ...this.resumen(socio, vigente) },
      historial,
    };
  }

  async porDni(dni: string) {
    if (!/^\d{8}$/.test(dni || '')) return null;
    return this.prisma.member.findUnique({ where: { dni }, include: { consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1, select: { tipo: true, aceptado: true } } } });
  }

  /**
   * Tarjeta que ve recepcion: lo minimo para decidir en un vistazo.
   * El semaforo lo define el estado, no el texto.
   */
  resumen(socio: any, membresia: any | null, dentro = false) {
    const dias = membresia ? diasRestantes(membresia.fechaFin) : null;
    const pausa = pausaActual(membresia);
    const cuenta = membresia && Array.isArray(membresia.payments) ? cuentaDe(membresia) : null;
    let estado: EstadoSocio = 'sin_membresia';
    if (membresia?.estado === 'vencida') estado = 'vencido';
    else if (membresia && membresia.estado !== 'anulada' && dias !== null) {
      if (dias < 0) estado = 'vencido';
      else if (dias <= this.AVISO_DIAS) estado = 'por_vencer';
      else estado = 'vigente';
    }
    return {
      id: socio.id,
      dni: socio.dni,
      codigoERP: socio.codigoERP ?? null,
      documentoERP: socio.documentoERP ?? null,
      estadoPortal: estadoPortal(socio),
      pinTemporalHasta: socio.pinTemporalHasta ? new Date(socio.pinTemporalHasta).toISOString() : null,
      consentimientoPendiente: consentimientoPendiente(socio),
      nombres: socio.nombres,
      apellidos: socio.apellidos,
      nombreCompleto: `${socio.nombres} ${socio.apellidos}`,
      telefono: socio.telefono,
      fotoUrl: socio.fotoUrl,
      esUniversitario: socio.esUniversitario,
      activo: socio.activo,
      estado,
      diasRestantes: dias,
      plan: membresia?.planNombre ?? membresia?.plan?.nombre ?? null,
      limiteAsistencias: membresia?.limiteAsistencias ?? null,
      asistenciasUsadas: membresia?.limiteAsistencias == null ? null : membresia.asistenciasUsadas,
      asistenciasRestantes: membresia?.limiteAsistencias == null ? null : Math.max(0, membresia.limiteAsistencias - membresia.asistenciasUsadas),
      vence: membresia ? formatoFecha(membresia.fechaFin) : null,
      inicio: membresia ? formatoFecha(membresia.fechaInicio) : null,
      inicioProgramado: !!membresia && membresia.fechaInicio > hoyLima(),
      pausaActualmente: !!pausa,
      pausaHasta: pausa ? formatoFecha(new Date(pausa.hasta)) : null,
      ...(cuenta ? { cuenta: { total: cuenta.total, pagado: cuenta.pagado, saldo: cuenta.saldo, fechaLimiteSaldo: cuenta.fechaLimiteSaldo, estado: cuenta.estado } } : {}),
      membresiaId: membresia?.id ?? null,
      dentro,
      hoy: formatoFecha(hoyLima()),
    };
  }

  /** Ultimo movimiento valido: si fue una entrada, el socio sigue dentro. */
  async estaDentro(memberId: string): Promise<boolean> {
    const ultimo = await this.prisma.checkIn.findFirst({
      where: { memberId, resultado: 'permitido' },
      orderBy: { timestamp: 'desc' },
      select: { tipo: true },
    });
    return ultimo?.tipo === 'entrada';
  }

  /**
   * Guarda la foto capturada con la webcam.
   *
   * La foto es el unico control real contra el prestamo del codigo: recepcion
   * compara la cara con la pantalla. Se guarda en disco, no en la base, para
   * que la base siga siendo liviana y facil de respaldar.
   */
  async guardarFoto(memberId: string, dataUrl: string) {
    const coincide = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      (dataUrl || '').trim(),
    );
    if (!coincide) throw new BadRequestException('La imagen no tiene un formato valido');

    const binario = Buffer.from(coincide[2], 'base64');
    if (binario.length > 2 * 1024 * 1024) {
      throw new BadRequestException('La foto pesa mas de 2 MB. Bajala de resolucion.');
    }

    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio) throw new NotFoundException('Socio no encontrado');

    const extension = coincide[1] === 'png' ? 'png' : coincide[1] === 'webp' ? 'webp' : 'jpg';
    const carpeta = join(carpetaArchivos(), 'socios');
    mkdirSync(carpeta, { recursive: true });
    writeFileSync(join(carpeta, `${memberId}.${extension}`), binario);

    // El sufijo obliga al navegador a recargar la foto cuando se reemplaza.
    const fotoUrl = `/uploads/socios/${memberId}.${extension}?v=${Date.now()}`;
    return sinSecretos(await this.prisma.member.update({ where: { id: memberId }, data: { fotoUrl } }));
  }

  /**
   * Derecho de acceso: todo lo que el gimnasio guarda de ese socio, en un
   * archivo que se le puede entregar.
   */
  async exportarDatos(memberId: string) {
    const socio = await this.prisma.member.findUnique({
      where: { id: memberId },
      include: {
        memberships: { include: { plan: true } },
        payments: true,
        checkIns: true,
        consents: true,
        complaints: true,
        entrenamientos: { include: { exercise: true } },
        medidas: true,
        invitados: true,
        ventas: { include: { items: true } },
      },
    });
    if (!socio) throw new NotFoundException('Socio no encontrado');

    return {
      generadoEl: new Date().toISOString(),
      aviso:
        'Copia de los datos personales que este gimnasio trata sobre el titular, entregada a su solicitud.',
      datos: sinSecretos(socio),
    };
  }

  /**
   * Derecho de supresion. No se borra la fila: los comprobantes y los pagos
   * tienen que sobrevivir por obligacion tributaria. Lo que desaparece es la
   * identidad, que es justo lo que protege la ley.
   */
  async anonimizar(memberId: string, motivo: string) {
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio) throw new NotFoundException('Socio no encontrado');
    if (socio.dni?.startsWith('ANON')) throw new BadRequestException('Ese socio ya fue anonimizado');

    if (socio.fotoUrl) {
      const archivo = join(carpetaArchivos(), socio.fotoUrl.split('?')[0].replace(/^\/uploads\//, ''));
      if (existsSync(archivo)) unlinkSync(archivo);
    }

    // Lo que el socio anoto de si mismo se va con el; los pagos y comprobantes
    // se quedan porque los exige la norma tributaria.
    const pinHashAnonimo = await hashPassword(pinAleatorio());
    const actualizado = await this.prisma.$transaction(async (tx) => {
      await tx.credential.deleteMany({ where: { memberId } });
      await tx.bodyLog.deleteMany({ where: { memberId } });
      await tx.workoutSet.deleteMany({ where: { memberId } });
      await tx.portalActivation.deleteMany({ where: { memberId } });
      return tx.member.update({ where: { id: memberId }, data: {
        dni: `ANON-${memberId.slice(-8)}`,
        codigoERP: null,
        documentoERP: null,
        portalVersion: { increment: 1 },
        pinHash: pinHashAnonimo,
        pinCambiado: false,
        pinTemporalHasta: null,
        nombres: 'Socio',
        apellidos: 'anonimizado',
        telefono: null,
        email: null,
        direccion: null,
        fotoUrl: null,
        notas: `Datos suprimidos a solicitud del titular. Motivo: ${motivo || 'no indicado'}`,
        activo: false,
      } });
    });
    return sinSecretos(actualizado);
  }
}
