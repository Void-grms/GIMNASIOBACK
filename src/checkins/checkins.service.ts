import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from '../members/members.service';
import { QrService } from '../qr/qr.service';
import { diasRestantes, formatoFecha, hoyLima, rangoDelDia, soloFecha } from '../common/fechas';
import { leerIdentificador } from './identificador';
import { elegirMembresia, pausaActual } from '../memberships/cuenta.util';

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
  private async ultimoMovimiento(memberId: string, db: Prisma.TransactionClient = this.prisma) {
    return db.checkIn.findFirst({
      where: { memberId, resultado: 'permitido' },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    });
  }

  /** Todos los escritores de presencia toman primero el mismo lock de base por socio. */
  private async conSocioBloqueado<T>(memberId: string, trabajo: (tx: Prisma.TransactionClient, socio: any) => Promise<T>): Promise<T> {
    for (let intento = 0; intento < 3; intento++) {
      try {
        return await this.prisma.$transaction(async tx => {
          // UPDATE bloquea la fila hasta commit en PostgreSQL y toma el lock de escritura en SQLite.
          // Incrementar cero conserva las sesiones del portal y funciona entre varias replicas.
          const bloqueado = await tx.member.updateMany({ where: { id: memberId }, data: { portalVersion: { increment: 0 } } });
          if (bloqueado.count !== 1) throw new NotFoundException('Socio no encontrado');
          const socio = await tx.member.findUnique({
            where: { id: memberId },
            include: { consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1, select: { tipo: true, aceptado: true } } },
          });
          if (!socio) throw new NotFoundException('Socio no encontrado');
          return trabajo(tx, socio);
        }, { maxWait: 10000, timeout: 10000 });
      } catch (error) {
        if (error?.code === 'P2028') throw new ServiceUnavailableException('Hay otro registro en curso. Intenta de nuevo en unos segundos.');
        // La transaccion fallida ya se revirtio: una colision de escritores se vuelve a leer completa.
        const reintentable = ['P2034', 'P1008'].includes(error?.code);
        if (!reintentable) throw error;
        if (intento === 2) throw new ServiceUnavailableException('Hay otro registro en curso. Intenta de nuevo en unos segundos.');
        await new Promise(resolve => setTimeout(resolve, 25 * (intento + 1)));
      }
    }
  }

  private async membresiaVigente(memberId: string, db: Prisma.TransactionClient, hoy = hoyLima()) {
    const lista = await db.membership.findMany({ where: { memberId, estado: 'activa' }, orderBy: [{ createdAt: 'desc' }, { fechaFin: 'desc' }, { id: 'desc' }], include: { plan: true, congelamientos: true, payments: { select: { monto: true, montoCentimos: true } } } });
    return elegirMembresia(lista, hoy);
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
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
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
   * Entrada de recepcion: acepta QR, DNI y el codigo conservado del ERP.
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
        include: { member: { include: { consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1, select: { tipo: true, aceptado: true } } } } },
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

    const identificador = leerIdentificador(texto);
    if (!identificador) {
      return this.denegar(null, 'entrada', 'manual', dispositivo, 'Codigo no reconocido');
    }
    const { tipo, valor } = identificador;
    const candidatos = await this.prisma.member.findMany({
      where: tipo === 'erp'
        ? { codigoERP: valor }
        : tipo === 'dni'
          ? { dni: valor }
          : { OR: [{ codigoERP: valor }, ...(valor.length === 8 ? [{ dni: valor }] : [])] },
      take: 2,
      include: { consents: { where: { tipo: 'datos_personales', aceptado: true }, take: 1, select: { tipo: true, aceptado: true } } },
    });
    if (candidatos.length > 1) {
      return this.denegar(
        null, 'entrada', 'manual', dispositivo,
        'Coinciden el codigo ERP y el DNI de distintos socios. Escribe ERP: seguido del codigo o DNI: seguido del documento.',
      );
    }
    const socio = candidatos[0];
    if (!socio) {
      return this.denegar(null, 'entrada', 'manual', dispositivo, 'No hay socio con ese codigo o DNI');
    }
    const metodo = tipo === 'erp' || (socio.codigoERP === valor && socio.dni !== valor) ? 'erp' : 'manual';
    return this.registrar(socio, metodo, dispositivo);
  }

  /** Decide si toca entrada o salida y aplica las reglas de cada una. */
  async registrar(
    socio: any,
    metodo: string,
    dispositivo?: string,
    forzarTipo?: TipoMovimiento,
  ): Promise<ResultadoCheckIn> {
    return this.conSocioBloqueado(socio.id, (tx, actual) => this.registrarBloqueado(actual, metodo, dispositivo, forzarTipo, tx));
  }

  /** Leer ultimo, decidir y escribir pertenecen a la misma transaccion y al mismo socio bloqueado. */
  private async registrarBloqueado(
    socio: any,
    metodo: string,
    dispositivo: string | undefined,
    forzarTipo: TipoMovimiento | undefined,
    tx: Prisma.TransactionClient,
  ): Promise<ResultadoCheckIn> {
    const ultimo = await this.ultimoMovimiento(socio.id, tx);

    // Dos confirmaciones explicitas de entrada/salida no deben crear movimientos consecutivos iguales.
    if (forzarTipo && ((ultimo && ultimo.tipo === forzarTipo) || (!ultimo && forzarTipo === 'salida'))) {
      const membresia = await this.membresiaVigente(socio.id, tx);
      return { resultado: 'repetido', tipo: forzarTipo, motivo: `El socio ya tiene registrada la ${forzarTipo}`,
        socio: this.members.resumen(socio, membresia, forzarTipo === 'entrada'), checkInId: ultimo?.id ?? null };
    }

    if (ultimo && Date.now() - ultimo.timestamp.getTime() < this.REBOTE_SEG * 1000) {
      const membresia = await this.membresiaVigente(socio.id, tx);
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
      const membresia = await this.membresiaVigente(socio.id, tx);
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
      const membresia = await this.membresiaVigente(socio.id, tx);
      const casillero = await this.liberarCasillero(socio.id, tx);
      const aviso = casillero ? `Casillero ${casillero} liberado: que devuelva la llave.` : undefined;
      const checkIn = await tx.checkIn.create({
        data: {
          memberId: socio.id,
          membershipId: membresia?.id || null,
          tipo: 'salida',
          metodo,
          dispositivo: dispositivo || null,
          resultado: 'permitido',
          timestamp: new Date(),
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

    return this.evaluarEntrada(socio, metodo, dispositivo, tx);
  }

  /** Reglas de la entrada: socio activo, membresia vigente y ya empezada. */
  private async evaluarEntrada(
    socio: any,
    metodo: string,
    dispositivo: string | undefined,
    tx: Prisma.TransactionClient,
  ): Promise<ResultadoCheckIn> {
    if (!socio.activo) {
      return this.denegar(socio, 'entrada', metodo, dispositivo, 'Socio dado de baja', null, tx);
    }

    const instante = new Date();
    const hoy = hoyLima(instante);
    const membresia = await this.membresiaVigente(socio.id, tx, hoy);

    if (!membresia) {
      return this.denegar(socio, 'entrada', metodo, dispositivo, 'Sin membresia registrada', null, tx);
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
        tx,
      );
    }
    if (soloFecha(membresia.fechaInicio).getTime() > hoy.getTime()) {
      return this.denegar(socio, 'entrada', metodo, dispositivo, 'La membresia aun no empieza', membresia, tx);
    }
    const pausa = pausaActual(membresia, hoy);
    if (pausa) return this.denegar(socio, 'entrada', metodo, dispositivo, `Membresía congelada hasta ${formatoFecha(pausa.hasta)}. Su vigencia se amplió por los días autorizados.`, membresia, tx);

    if (membresia.limiteAsistencias != null) {
      const rango = rangoDelDia(hoy);
      // Un regreso durante el mismo dia no consume otro dia de entrenamiento.
      const yaAsistio = await tx.checkIn.findFirst({
        where: { membershipId: membresia.id, resultado: 'permitido', tipo: 'entrada', timestamp: { gte: rango.inicio, lt: rango.fin } },
        select: { id: true },
      });
      if (!yaAsistio) {
        if (membresia.asistenciasUsadas >= membresia.limiteAsistencias) {
          return this.denegar(socio, 'entrada', metodo, dispositivo,
            `Asistencias agotadas: ya utilizo las ${membresia.limiteAsistencias} de su membresia. Puede renovar en recepcion.`, membresia, tx);
        }
        // El lock del socio protege contador, consulta de dia e insercion frente a otras replicas.
        await tx.membership.update({ where: { id: membresia.id }, data: { asistenciasUsadas: { increment: 1 } } });
        membresia.asistenciasUsadas++;
      }
    }

    const checkIn = await tx.checkIn.create({
      data: {
        memberId: socio.id,
        membershipId: membresia.id,
        tipo: 'entrada',
        metodo,
        dispositivo: dispositivo || null,
        resultado: 'permitido',
        timestamp: instante,
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
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ResultadoCheckIn> {
    let checkInId: string | null = null;
    if (socio) {
      const registro = await db.checkIn.create({
        data: {
          memberId: socio.id,
          membershipId: membresia?.id || null,
          tipo,
          metodo,
          dispositivo: dispositivo || null,
          resultado: 'denegado',
          motivo,
          timestamp: new Date(),
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
      include: { member: true, membership: { include: { plan: true, congelamientos: true, payments: { select: { monto: true, montoCentimos: true } } } } },
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
  private async liberarCasillero(memberId: string, tx: Prisma.TransactionClient): Promise<number | null> {
    const casillero = await tx.locker.findUnique({ where: { memberId } });
    if (!casillero) return null;
    const liberado = await tx.locker.updateMany({
      where: { id: casillero.id, memberId },
      data: { memberId: null, ocupadoDesde: null },
    });
    return liberado.count === 1 ? casillero.numero : null;
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

    let cerradas = 0;
    for (const d of vencidas) {
      const cerrada = await this.conSocioBloqueado(d.memberId, async tx => {
        // Otra recepcion o replica del cron pudo cerrar/reabrir la sesion desde la consulta inicial.
        const ultimo = await this.ultimoMovimiento(d.memberId, tx);
        if (!ultimo || ultimo.tipo !== 'entrada' || ultimo.timestamp.getTime() >= limite) return false;
        await this.liberarCasillero(d.memberId, tx);
        await tx.checkIn.create({ data: {
          memberId: d.memberId, tipo: 'salida', metodo: 'auto', resultado: 'permitido',
          motivo: 'Cierre automatico: no marco salida', timestamp: new Date(),
        } });
        return true;
      });
      if (cerrada) cerradas++;
    }
    if (cerradas) this.log.log(`Cerradas ${cerradas} sesion(es) sin salida`);
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
    return this.conSocioBloqueado(memberId, async (tx, socio) => {
      const ultimo = await this.ultimoMovimiento(memberId, tx);
      if (ultimo && ultimo.tipo === 'entrada') {
        if (!confirmarSalida) {
          return {
            accion: 'confirmar_salida' as const,
            dentro: true,
            desde: ultimo.timestamp,
            mensaje: 'Confirma que ya te vas.',
          };
        }
        const r = await this.registrarBloqueado(socio, 'portal', 'portal-socio', 'salida', tx);
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

      // La repeticion de una confirmacion de salida no se convierte en un anuncio de nueva llegada.
      if (confirmarSalida) {
        return { accion: 'salida_registrada' as const, dentro: false, mensaje: 'La salida ya estaba registrada.' };
      }

      const ahora = new Date();
      const pendiente = await tx.preCheckIn.findFirst({
        where: { memberId, estado: 'pendiente', expiresAt: { gt: ahora } },
      });
      const aviso =
        pendiente ??
        (await tx.preCheckIn.create({
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
    });
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
      select: { memberId: true },
    });
    if (!aviso) throw new NotFoundException('Aviso no encontrado');
    return this.conSocioBloqueado(aviso.memberId, async (tx, socio) => {
      const tomado = await tx.preCheckIn.updateMany({
        where: { id: preCheckInId, memberId: socio.id, estado: 'pendiente', expiresAt: { gt: new Date() } },
        data: { estado: 'confirmado', confirmedAt: new Date() },
      });
      if (tomado.count !== 1) throw new BadRequestException('Ese aviso ya fue atendido o expiro');
      const resultado = await this.registrarBloqueado(socio, 'prechequeo', dispositivo, 'entrada', tx);
      await tx.preCheckIn.update({ where: { id: preCheckInId }, data: { checkInId: resultado.checkInId } });
      return resultado;
    });
  }

  async descartarLlegada(preCheckInId: string) {
    const aviso = await this.prisma.preCheckIn.findUnique({ where: { id: preCheckInId }, select: { memberId: true } });
    if (!aviso) throw new NotFoundException('Aviso no encontrado');
    return this.conSocioBloqueado(aviso.memberId, async tx => {
      const descartado = await tx.preCheckIn.updateMany({ where: { id: preCheckInId, estado: 'pendiente' }, data: { estado: 'descartado' } });
      if (descartado.count !== 1) throw new BadRequestException('Ese aviso ya fue atendido o expiro');
      return tx.preCheckIn.findUnique({ where: { id: preCheckInId } });
    });
  }
}
