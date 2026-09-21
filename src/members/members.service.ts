import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { randomInt } from 'crypto';
import { join } from 'path';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { SettingsService } from '../settings/settings.service';
import { diasRestantes, formatoFecha, hoyLima } from '../common/fechas';
import { carpetaArchivos, esPostgres } from '../common/archivos';

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

  private soloDigitos(v: string) {
    return (v || '').replace(/\D/g, '');
  }

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
    pin?: string;
    consentimiento?: boolean;
  }) {
    const dni = this.soloDigitos(dto.dni);
    if (dni.length !== 8) throw new BadRequestException('El DNI debe tener 8 digitos');

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
    const pin = dto.pin ? this.soloDigitos(dto.pin) : this.pinAleatorio();
    if (pin.length !== 4) throw new BadRequestException('El PIN debe tener 4 digitos');

    const socio = await this.prisma.member.create({
      data: {
        dni,
        nombres: dto.nombres.trim(),
        apellidos: dto.apellidos.trim(),
        telefono: dto.telefono?.trim() || null,
        email: dto.email?.trim().toLowerCase() || null,
        fotoUrl: dto.fotoUrl || null,
        direccion: dto.direccion?.trim() || null,
        esUniversitario: !!dto.esUniversitario,
        notas: dto.notas || null,
        pinHash: bcrypt.hashSync(pin, 10),
        pinCambiado: !!dto.pin,
        credential: { create: { tipo: 'qr', secret: this.qr.nuevoSecreto() } },
      },
    });

    await this.registrarConsentimiento(socio.id, 'datos_personales', 'recepcion');

    // El PIN en claro viaja una sola vez, en esta respuesta, para que recepcion
    // se lo entregue al socio. No se guarda en ningun lado.
    return { ...socio, pinInicial: pin };
  }

  /** Cuatro digitos al azar, sin relacion con el documento del socio. */
  private pinAleatorio(): string {
    return String(randomInt(0, 10000)).padStart(4, '0');
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
    const data: Record<string, any> = {};
    for (const campo of ['nombres', 'apellidos', 'telefono', 'email', 'fotoUrl', 'notas']) {
      if (dto[campo] !== undefined) data[campo] = dto[campo];
    }
    if (dto.esUniversitario !== undefined) data.esUniversitario = !!dto.esUniversitario;
    if (dto.activo !== undefined) data.activo = !!dto.activo;
    if (dto.pin) {
      const pin = this.soloDigitos(dto.pin);
      if (pin.length !== 4) throw new BadRequestException('El PIN debe tener 4 digitos');
      data.pinHash = bcrypt.hashSync(pin, 10);
      data.pinCambiado = true;
    }
    return this.prisma.member.update({ where: { id }, data });
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
              { nombres: { contains: texto, ...sinMayus } },
              { apellidos: { contains: texto, ...sinMayus } },
            ],
          }
        : undefined,
      orderBy: [{ apellidos: 'asc' }, { nombres: 'asc' }],
      take: limite,
      include: { memberships: { orderBy: { fechaFin: 'desc' }, take: 1, include: { plan: true } } },
    });
    return socios.map((s) => this.resumen(s, s.memberships[0]));
  }

  /** Membresia con la fecha de fin mas lejana que no este anulada. */
  async membresiaVigente(memberId: string) {
    return this.prisma.membership.findFirst({
      where: { memberId, estado: 'activa' },
      orderBy: { fechaFin: 'desc' },
      include: { plan: true },
    });
  }

  async obtener(id: string) {
    const socio = await this.prisma.member.findUnique({
      where: { id },
      include: {
        memberships: { orderBy: { fechaInicio: 'desc' }, include: { plan: true } },
        payments: { orderBy: { fecha: 'desc' }, take: 20 },
        checkIns: { orderBy: { timestamp: 'desc' }, take: 20 },
      },
    });
    if (!socio) throw new NotFoundException('Socio no encontrado');
    const vigente = socio.memberships.find((m) => m.estado === 'activa') || null;
    return {
      ...this.resumen(socio, vigente, await this.estaDentro(id)),
      socio,
      historial: socio.memberships,
    };
  }

  async porDni(dni: string) {
    return this.prisma.member.findUnique({ where: { dni: this.soloDigitos(dni) } });
  }

  /**
   * Tarjeta que ve recepcion: lo minimo para decidir en un vistazo.
   * El semaforo lo define el estado, no el texto.
   */
  resumen(socio: any, membresia: any | null, dentro = false) {
    const dias = membresia ? diasRestantes(membresia.fechaFin) : null;
    let estado: EstadoSocio = 'sin_membresia';
    if (membresia && dias !== null) {
      if (dias < 0) estado = 'vencido';
      else if (dias <= this.AVISO_DIAS) estado = 'por_vencer';
      else estado = 'vigente';
    }
    return {
      id: socio.id,
      dni: socio.dni,
      nombres: socio.nombres,
      apellidos: socio.apellidos,
      nombreCompleto: `${socio.nombres} ${socio.apellidos}`,
      telefono: socio.telefono,
      fotoUrl: socio.fotoUrl,
      esUniversitario: socio.esUniversitario,
      activo: socio.activo,
      estado,
      diasRestantes: dias,
      plan: membresia?.plan?.nombre ?? null,
      vence: membresia ? formatoFecha(membresia.fechaFin) : null,
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
    return this.prisma.member.update({ where: { id: memberId }, data: { fotoUrl } });
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

    const { pinHash, ...sinSecretos } = socio as any;
    return {
      generadoEl: new Date().toISOString(),
      aviso:
        'Copia de los datos personales que este gimnasio trata sobre el titular, entregada a su solicitud.',
      datos: sinSecretos,
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
    if (socio.dni.startsWith('ANON')) throw new BadRequestException('Ese socio ya fue anonimizado');

    if (socio.fotoUrl) {
      const archivo = join(carpetaArchivos(), socio.fotoUrl.split('?')[0].replace(/^\/uploads\//, ''));
      if (existsSync(archivo)) unlinkSync(archivo);
    }

    await this.prisma.credential.deleteMany({ where: { memberId } });
    // Lo que el socio anoto de si mismo se va con el; los pagos y comprobantes
    // se quedan porque los exige la norma tributaria.
    await this.prisma.bodyLog.deleteMany({ where: { memberId } });
    await this.prisma.workoutSet.deleteMany({ where: { memberId } });

    return this.prisma.member.update({
      where: { id: memberId },
      data: {
        dni: `ANON-${memberId.slice(-8)}`,
        nombres: 'Socio',
        apellidos: 'anonimizado',
        telefono: null,
        email: null,
        direccion: null,
        fotoUrl: null,
        notas: `Datos suprimidos a solicitud del titular. Motivo: ${motivo || 'no indicado'}`,
        activo: false,
      },
    });
  }
}
