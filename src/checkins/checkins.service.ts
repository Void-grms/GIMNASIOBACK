import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from '../members/members.service';
import { QrService } from '../qr/qr.service';
import { diasRestantes, hoyLima, soloFecha } from '../common/fechas';

export type TipoMovimiento = 'entrada' | 'salida';

export type ResultadoCheckIn = {
  resultado: 'permitido' | 'denegado' | 'repetido';
  tipo: TipoMovimiento;
  motivo?: string;
  socio: any;
  checkInId: string | null;
  casilleroLiberado?: number | null;
};

@Injectable()
export class CheckinsService {
  private readonly log = new Logger('Accesos');

  /**
   * Escanear dos veces seguidas (el lector a veces dispara doble) no debe
   * registrar una salida inmediata despues de la entrada.
   */
  private readonly REBOTE_SEG = 30;

  /**
   * Nadie entrena en menos de esto. Un segundo escaneo dentro de esta ventana
   * despues de entrar (el socio vuelve a acercar el celular, o el escaner del
   * celular de recepcion lo lee dos veces) no lo saca del gimnasio.
   */
  private readonly SALIDA_MINIMA_MIN = 3;

  /**
   * Un socio que se fue sin marcar salida no puede quedar "dentro" para siempre.
   * Pasadas estas horas, el sistema le cierra la sesion solo.
   */
  private readonly HORAS_MAX_DENTRO = Number(process.env.HORAS_MAX_DENTRO || 6);

  constructor(
    private prisma: PrismaService,
    private members: MembersService,
    private qr: QrService,
  ) {}

  // ---------------------------------------------------------------- presencia

  /** Ultimo movimiento valido del socio. */
  private async ultimoMovimiento(memberId: string) {
    return this.prisma.checkIn.findFirst({
      where: { memberId, resultado: 'permitido' },
      orderBy: { timestamp: 'desc' },
    });
  }

  async estaDentro(memberId: string): Promise<boolean> {
    const ultimo = await this.ultimoMovimiento(memberId);
    return !!ultimo && ultimo.tipo === 'entrada';
  }

  /**
   * Socios dentro del gimnasio en este momento: los que su ultimo movimiento
   * de las ultimas 24 horas fue una entrada. Es exacto, no una estimacion.
   */
  async sociosDentro(): Promise<{ memberId: string; desde: Date }[]> {
    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const movimientos = await this.prisma.checkIn.findMany({
      where: { resultado: 'permitido', timestamp: { gte: desde } },
      orderBy: { timestamp: 'desc' },
      select: { memberId: true, tipo: true, timestamp: true },
    });

    const vistos = new Set<string>();
    const dentro: { memberId: string; desde: Date }[] = [];
    for (const m of movimientos) {
      if (vistos.has(m.memberId)) continue;
      vistos.add(m.memberId);
      if (m.tipo === 'entrada') dentro.push({ memberId: m.memberId, desde: m.timestamp });
    }
    return dentro;
  }

  // ----------------------------------------------------------------- escaneo

  /**
   * Entrada unica de recepcion: acepta el QR del socio o su DNI tecleado.
   * El lector USB se comporta como teclado, asi que ambos llegan igual.
   *
   * No hay que elegir entre entrada y salida: el sistema alterna solo segun
   * donde este el socio. Eso hace que el anti-passback sea estructural, porque
   * nadie puede entrar dos veces sin haber salido.
   */
  async escanear(codigo: string, dispositivo?: string): Promise<ResultadoCheckIn> {
    const texto = (codigo || '').trim();
    if (!texto) throw new BadRequestException('Codigo vacio');

    const memberIdQr = this.qr.leerMemberId(texto);

    if (memberIdQr) {
      const credencial = await this.prisma.credential.findUnique({
        where: { memberId: memberIdQr },
        include: { member: true },
      });
      if (!credencial || !credencial.activo || !credencial.member) {
        return this.denegar(null, 'entrada', 'qr', dispositivo, 'Credencial no reconocida o revocada');
      }
      if (!this.qr.validar(texto, credencial.secret)) {
        return this.denegar(
          credencial.member,
          'entrada',
          'qr',
          dispositivo,
          'Codigo vencido o alterado. Pide al socio que refresque su pantalla.',
        );
      }
      return this.registrar(credencial.member, 'qr', dispositivo);
    }

    const dni = texto.replace(/\D/g, '');
    if (dni.length !== 8) {
      return this.denegar(null, 'entrada', 'manual', dispositivo, 'Codigo no reconocido');
    }
    const socio = await this.members.porDni(dni);
    if (!socio) {
      return this.denegar(null, 'entrada', 'manual', dispositivo, `Sin socio con DNI ${dni}`);
    }
    return this.registrar(socio, 'manual', dispositivo);
  }

  /** Decide si toca entrada o salida y aplica las reglas de cada una. */
  async registrar(
    socio: any,
    metodo: string,
    dispositivo?: string,
    forzarTipo?: TipoMovimiento,
  ): Promise<ResultadoCheckIn> {
    const ultimo = await this.ultimoMovimiento(socio.id);

    if (ultimo && Date.now() - ultimo.timestamp.getTime() < this.REBOTE_SEG * 1000) {
      const membresia = await this.members.membresiaVigente(socio.id);
      return {
        resultado: 'repetido',
        tipo: ultimo.tipo as TipoMovimiento,
        motivo: `Ya se registro la ${ultimo.tipo} hace unos segundos`,
        socio: this.members.resumen(socio, membresia, ultimo.tipo === 'entrada'),
        checkInId: ultimo.id,
      };
    }

    const dentro = !!ultimo && ultimo.tipo === 'entrada';

    if (
      !forzarTipo &&
      dentro &&
      Date.now() - ultimo.timestamp.getTime() < this.SALIDA_MINIMA_MIN * 60 * 1000
    ) {
      const membresia = await this.members.membresiaVigente(socio.id);
      return {
        resultado: 'repetido',
        tipo: 'entrada',
        motivo: 'Acaba de entrar. La salida se marca recien pasados unos minutos.',
        socio: this.members.resumen(socio, membresia, true),
        checkInId: ultimo.id,
      };
    }

    const tipo: TipoMovimiento = forzarTipo ?? (dentro ? 'salida' : 'entrada');

    // Salir siempre se puede, incluso con la membresia vencida: nadie se queda
    // encerrado por no haber pagado.
    if (tipo === 'salida') {
      const membresia = await this.members.membresiaVigente(socio.id);
      const casillero = await this.liberarCasillero(socio.id);
      const aviso = casillero ? `Casillero ${casillero} liberado: que devuelva la llave.` : undefined;
      const checkIn = await this.prisma.checkIn.create({
        data: {
          memberId: socio.id,
          membershipId: membresia?.id || null,
          tipo: 'salida',
          metodo,
          dispositivo: dispositivo || null,
          resultado: 'permitido',
          motivo: aviso ?? null,
        },
      });
      return {
        resultado: 'permitido',
        tipo: 'salida',
        motivo: aviso,
        casilleroLiberado: casillero,
        socio: this.members.resumen(socio, membresia, false),
        checkInId: checkIn.id,
      };
    }

    return this.evaluarEntrada(socio, metodo, dispositivo);
  }

  /** Reglas de la entrada: socio activo, membresia vigente y ya empezada. */
  private async evaluarEntrada(
    socio: any,
    metodo: string,
    dispositivo?: string,
  ): Promise<ResultadoCheckIn> {
    if (!socio.activo) {
      return this.denegar(socio, 'entrada', metodo, dispositivo, 'Socio dado de baja');
    }

    const membresia = await this.members.membresiaVigente(socio.id);
    const hoy = hoyLima();

    if (!membresia) {
      return this.denegar(socio, 'entrada', metodo, dispositivo, 'Sin membresia registrada');
    }
    if (soloFecha(membresia.fechaFin).getTime() < hoy.getTime()) {
      const dias = Math.abs(diasRestantes(membresia.fechaFin));
      return this.denegar(
        socio,
        'entrada',
        metodo,
        dispositivo,
        `Membresia vencida hace ${dias} dia(s)`,
        membresia,
      );
    }
    if (soloFecha(membresia.fechaInicio).getTime() > hoy.getTime()) {
      return this.denegar(socio, 'entrada', metodo, dispositivo, 'La membresia aun no empieza', membresia);
    }

    const checkIn = await this.prisma.checkIn.create({
      data: {
        memberId: socio.id,
        membershipId: membresia.id,
        tipo: 'entrada',
        metodo,
        dispositivo: dispositivo || null,
        resultado: 'permitido',
      },
    });

    return {
      resultado: 'permitido',
      tipo: 'entrada',
      socio: this.members.resumen(socio, membresia, true),
      checkInId: checkIn.id,
    };
  }

  private async denegar(
    socio: any | null,
    tipo: TipoMovimiento,
    metodo: string,
    dispositivo: string | undefined,
    motivo: string,
    membresia: any = null,
  ): Promise<ResultadoCheckIn> {
    let checkInId: string | null = null;
    if (socio) {
      const registro = await this.prisma.checkIn.create({
        data: {
          memberId: socio.id,
          membershipId: membresia?.id || null,
          tipo,
          metodo,
          dispositivo: dispositivo || null,
          resultado: 'denegado',
          motivo,
        },
      });
      checkInId = registro.id;
    }
    return {
      resultado: 'denegado',
      tipo,
      motivo,
      socio: socio ? this.members.resumen(socio, membresia, false) : null,
      checkInId,
    };
  }

  // --------------------------------------------------------------- consultas

  async recientes(limite = 15) {
    const registros = await this.prisma.checkIn.findMany({
      orderBy: { timestamp: 'desc' },
      take: limite,
      include: { member: true, membership: { include: { plan: true } } },
    });
    return registros.map((r) => ({
      id: r.id,
      hora: r.timestamp,
      tipo: r.tipo,
      metodo: r.metodo,
      dispositivo: r.dispositivo,
      resultado: r.resultado,
      motivo: r.motivo,
      socio: this.members.resumen(r.member, r.membership, r.tipo === 'entrada'),
    }));
  }

  /** Quienes estan dentro ahora mismo, con la hora en que entraron. */
  async listaDentro() {
    const dentro = await this.sociosDentro();
    if (dentro.length === 0) return [];

    const socios = await this.prisma.member.findMany({
      where: { id: { in: dentro.map((d) => d.memberId) } },
    });
    const porId = new Map<string, any>(socios.map((s) => [s.id, s] as [string, any]));
    const ocupados = await this.prisma.locker.findMany({
      where: { memberId: { in: dentro.map((d) => d.memberId) } },
    });
    const casilleros = new Map(ocupados.map((c) => [c.memberId!, c.numero]));

    const salida = [];
    for (const d of dentro) {
      const socio = porId.get(d.memberId);
      if (!socio) continue;
      const membresia = await this.members.membresiaVigente(socio.id);
      salida.push({
        desde: d.desde,
        casillero: casilleros.get(socio.id) ?? null,
        socio: this.members.resumen(socio, membresia, true),
      });
    }
    return salida.sort((a, b) => b.desde.getTime() - a.desde.getTime());
  }

  /**
   * El casillero alquilado vuelve a quedar libre en cuanto el socio sale.
   * Devuelve el numero liberado para avisarle a recepcion que pida la llave.
   */
  private async liberarCasillero(memberId: string): Promise<number | null> {
    const casillero = await this.prisma.locker.findUnique({ where: { memberId } });
    if (!casillero) return null;
    await this.prisma.locker.update({
      where: { id: casillero.id },
      data: { memberId: null, ocupadoDesde: null },
    });
    return casillero.numero;
  }

  // ------------------------------------------------- cierre automatico diario

  /**
   * Cierra las sesiones de quienes se fueron sin marcar salida. Sin esto, el
   * contador de "dentro ahora" se va inflando y deja de servir para nada.
   */
  @Cron('*/30 * * * *')
  async cerrarSesionesOlvidadas() {
    const limite = Date.now() - this.HORAS_MAX_DENTRO * 60 * 60 * 1000;
    const dentro = await this.sociosDentro();
    const vencidas = dentro.filter((d) => d.desde.getTime() < limite);
    if (vencidas.length === 0) return;

    await this.prisma.checkIn.createMany({
      data: vencidas.map((d) => ({
        memberId: d.memberId,
        tipo: 'salida',
        metodo: 'auto',
        resultado: 'permitido',
        motivo: 'Cierre automatico: no marco salida',
      })),
    });
    await this.prisma.locker.updateMany({
      where: { memberId: { in: vencidas.map((d) => d.memberId) } },
      data: { memberId: null, ocupadoDesde: null },
    });
    this.log.log(`Cerradas ${vencidas.length} sesion(es) sin salida`);
  }

  // ------------------------------------ pre check-in desde el celular del socio

  /** Cuanto vive un aviso de llegada en la pantalla de recepcion. */
  private readonly PRECHECK_MIN = 3;

  /**
   * Lo que el portal consulta cada pocos segundos para enterarse de que
   * recepcion ya confirmo el ingreso. Es barato a proposito.
   */
  async presencia(memberId: string) {
    const ultimo = await this.ultimoMovimiento(memberId);
    const dentro = !!ultimo && ultimo.tipo === 'entrada';
    return { dentro, desde: dentro ? ultimo!.timestamp : null };
  }

  /**
   * Boton del portal. Si el socio esta fuera, anuncia su llegada y recepcion
   * confirma (el ingreso lo autoriza recepcion, nunca el celular del socio).
   * Si esta dentro, marcar salida no necesita permiso de nadie, pero si una
   * confirmacion explicita: sin ella solo se responde que falta confirmar, asi
   * un toque accidental en el bolsillo no cierra la sesion.
   */
  async alternarPresencia(memberId: string, confirmarSalida = false) {
    const socio = await this.prisma.member.findUnique({ where: { id: memberId } });
    if (!socio) throw new NotFoundException('Socio no encontrado');

    const ultimo = await this.ultimoMovimiento(memberId);
    if (ultimo && ultimo.tipo === 'entrada') {
      if (!confirmarSalida) {
        return {
          accion: 'confirmar_salida' as const,
          dentro: true,
          desde: ultimo.timestamp,
          mensaje: 'Confirma que ya te vas.',
        };
      }
      const r = await this.registrar(socio, 'portal', 'portal-socio', 'salida');
      if (r.resultado !== 'permitido') {
        throw new BadRequestException('Acabas de entrar. Espera unos segundos para marcar la salida.');
      }
      return {
        accion: 'salida_registrada' as const,
        dentro: false,
        mensaje: 'Salida registrada. Nos vemos pronto.',
        resultado: r,
      };
    }

    const ahora = new Date();
    const pendiente = await this.prisma.preCheckIn.findFirst({
      where: { memberId, estado: 'pendiente', expiresAt: { gt: ahora } },
    });
    const aviso =
      pendiente ??
      (await this.prisma.preCheckIn.create({
        data: {
          memberId,
          tipo: 'entrada',
          expiresAt: new Date(ahora.getTime() + this.PRECHECK_MIN * 60 * 1000),
        },
      }));

    return {
      accion: 'entrada_anunciada' as const,
      dentro: false,
      expira: aviso.expiresAt,
      mensaje: 'Recepcion ya te ve en pantalla. Acercate al mostrador.',
    };
  }

  async llegadasPendientes() {
    const ahora = new Date();
    await this.prisma.preCheckIn.updateMany({
      where: { estado: 'pendiente', expiresAt: { lt: ahora } },
      data: { estado: 'expirado' },
    });
    const avisos = await this.prisma.preCheckIn.findMany({
      where: { estado: 'pendiente', expiresAt: { gt: ahora } },
      orderBy: { createdAt: 'asc' },
      include: { member: true },
    });

    const salida = [];
    for (const aviso of avisos) {
      const membresia = await this.members.membresiaVigente(aviso.memberId);
      salida.push({
        id: aviso.id,
        desde: aviso.createdAt,
        expira: aviso.expiresAt,
        socio: this.members.resumen(aviso.member, membresia, false),
      });
    }
    return salida;
  }

  async confirmarLlegada(preCheckInId: string, dispositivo?: string) {
    const aviso = await this.prisma.preCheckIn.findUnique({
      where: { id: preCheckInId },
      include: { member: true },
    });
    if (!aviso) throw new NotFoundException('Aviso no encontrado');
    if (aviso.estado !== 'pendiente') {
      throw new BadRequestException('Ese aviso ya fue atendido o expiro');
    }

    const resultado = await this.registrar(aviso.member, 'prechequeo', dispositivo, 'entrada');
    await this.prisma.preCheckIn.update({
      where: { id: preCheckInId },
      data: { estado: 'confirmado', confirmedAt: new Date(), checkInId: resultado.checkInId },
    });
    return resultado;
  }

  async descartarLlegada(preCheckInId: string) {
    return this.prisma.preCheckIn.update({
      where: { id: preCheckInId },
      data: { estado: 'descartado' },
    });
  }
}
