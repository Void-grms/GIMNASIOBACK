/**
 * Manejo de fechas del negocio.
 *
 * Regla: una membresia dura N dias CALENDARIO contando el dia de inicio.
 * 30 dias desde el 19 de setiembre vencen el 18 de octubre.
 *
 * Las fechas de negocio se guardan como medianoche UTC del dia de Lima
 * (Peru no tiene horario de verano, offset fijo -05:00). Asi un pago a las
 * 23:50 no corre el vencimiento un dia.
 */
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;
export const MS_DIA = 24 * 60 * 60 * 1000;

/** Dia de hoy en Lima, como medianoche UTC. */
export function hoyLima(ahora: Date = new Date()): Date {
  const lima = new Date(ahora.getTime() - LIMA_OFFSET_MS);
  return new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate()));
}

/** Normaliza cualquier fecha a la medianoche UTC de su dia. */
export function soloFecha(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function sumarDias(d: Date, dias: number): Date {
  return new Date(d.getTime() + dias * MS_DIA);
}

/** Ultimo dia valido de una membresia que arranca en `inicio` y dura `dias`. */
export function fechaFinDe(inicio: Date, dias: number): Date {
  return sumarDias(soloFecha(inicio), dias - 1);
}

/** Dias que faltan para vencer. 0 = vence hoy, negativo = ya vencio. */
export function diasRestantes(fechaFin: Date, ahora: Date = new Date()): number {
  return Math.round((soloFecha(fechaFin).getTime() - hoyLima(ahora).getTime()) / MS_DIA);
}

export function formatoFecha(d: Date): string {
  return soloFecha(d).toISOString().slice(0, 10);
}

/**
 * Fecha en que debe arrancar una nueva membresia.
 *
 * - Sin membresia previa vigente: arranca hoy.
 * - Con una vigente o recien vencida: arranca el dia siguiente al vencimiento,
 *   asi el socio no pierde ni gana dias por pagar antes o con atraso.
 * - Pasados los dias de gracia, arranca hoy: no se regalan dias de un socio
 *   que estuvo meses sin venir.
 */
export function inicioDeNuevaMembresia(
  finAnterior: Date | null,
  diasGracia: number,
  ahora: Date = new Date(),
): Date {
  const hoy = hoyLima(ahora);
  if (!finAnterior) return hoy;
  const siguiente = sumarDias(soloFecha(finAnterior), 1);
  if (siguiente.getTime() >= hoy.getTime()) return siguiente;
  const limite = sumarDias(siguiente, diasGracia);
  return limite.getTime() >= hoy.getTime() ? siguiente : hoy;
}

/**
 * Rango real de un dia de Lima, para filtrar timestamps.
 *
 * Ojo con la trampa: las fechas de negocio se guardan como medianoche UTC del
 * dia de Lima, pero un pago o un ingreso se guardan con la hora exacta. El dia
 * de Lima del 19 de setiembre va del 19 a las 05:00 UTC al 20 a las 05:00 UTC.
 * Filtrar por la medianoche UTC manda toda la noche del gimnasio al dia
 * siguiente, que es justo la franja de mas movimiento.
 */
export function rangoDelDia(dia: Date): { inicio: Date; fin: Date } {
  const inicio = new Date(soloFecha(dia).getTime() + LIMA_OFFSET_MS);
  return { inicio, fin: new Date(inicio.getTime() + MS_DIA) };
}

/** Rango que cubre desde el primer dia hasta el final del ultimo, hora de Lima. */
export function rangoEntre(desde: Date, hasta: Date): { inicio: Date; fin: Date } {
  return { inicio: rangoDelDia(desde).inicio, fin: rangoDelDia(hasta).fin };
}

/** Dia de Lima al que pertenece un instante, como YYYY-MM-DD. */
export function diaLimaDe(instante: Date): string {
  return formatoFecha(hoyLima(instante));
}

/** Convierte "2026-09-19" en una fecha de negocio. Sin valor, devuelve hoy. */
export function fechaDesdeTexto(texto?: string, porDefecto: Date = hoyLima()): Date {
  if (!texto) return porDefecto;
  const d = new Date(`${texto}T00:00:00Z`);
  return isNaN(d.getTime()) ? porDefecto : soloFecha(d);
}

/**
 * Feriados nacionales que caen dentro del plazo de un reclamo. La lista es
 * corta a proposito: se actualiza una vez al ano y evita depender de un
 * servicio externo para algo que solo mueve una fecha limite.
 */
export const FERIADOS_PERU = [
  '01-01', '05-01', '06-29', '07-23', '07-28', '07-29', '08-06',
  '08-30', '10-08', '11-01', '12-08', '12-09', '12-25',
];

function esHabil(d: Date): boolean {
  const diaSemana = d.getUTCDay();
  if (diaSemana === 0 || diaSemana === 6) return false;
  return !FERIADOS_PERU.includes(formatoFecha(d).slice(5));
}

/**
 * Suma dias habiles. El Codigo del Consumidor da 15 dias habiles para responder
 * un reclamo, y contarlos como corridos adelanta el vencimiento tres semanas.
 */
export function sumarDiasHabiles(desde: Date, dias: number): Date {
  let fecha = soloFecha(desde);
  let restantes = dias;
  while (restantes > 0) {
    fecha = sumarDias(fecha, 1);
    if (esHabil(fecha)) restantes--;
  }
  return fecha;
}
