/**
 * Validaciones propias de Peru. Viven aqui y no dentro de un DTO para poder
 * usarlas tambien en servicios, en el seed y en las pruebas.
 */
import { registerDecorator, ValidationOptions } from 'class-validator';

export const soloDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** DNI: 8 digitos. No tiene digito verificador publico, asi que solo largo. */
export function esDni(valor: string): boolean {
  return /^\d{8}$/.test(soloDigitos(valor));
}

/**
 * RUC: 11 digitos con digito verificador modulo 11.
 *
 * Vale la pena validarlo de verdad: un RUC mal tecleado en una factura obliga a
 * emitir una nota de credito y a rehacerla. Los pesos son fijos y el algoritmo
 * es el que usa SUNAT.
 */
export function esRuc(valor: string): boolean {
  const ruc = soloDigitos(valor);
  if (!/^\d{11}$/.test(ruc)) return false;

  // Tipos de contribuyente validos: persona natural (10), antiguos (15, 16, 17)
  // y persona juridica (20).
  if (!['10', '15', '16', '17', '20'].includes(ruc.slice(0, 2))) return false;

  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + Number(ruc[i]) * peso, 0);
  const resto = suma % 11;
  const esperado = resto === 0 ? 0 : resto === 1 ? 1 : 11 - resto;
  return esperado === Number(ruc[10]);
}

/** Celular peruano: 9 digitos que empiezan en 9. */
export function esCelular(valor: string): boolean {
  return /^9\d{8}$/.test(soloDigitos(valor));
}

/** Telefono fijo o celular, con o sin codigo de area. */
export function esTelefono(valor: string): boolean {
  const t = soloDigitos(valor);
  return t.length >= 6 && t.length <= 12;
}

export function esCarneExtranjeria(valor: string): boolean {
  return /^[A-Za-z0-9]{9,12}$/.test(String(valor ?? '').trim());
}

export function esPasaporte(valor: string): boolean {
  return /^[A-Za-z0-9]{6,12}$/.test(String(valor ?? '').trim());
}

/** Valida el documento segun su tipo. Es la puerta de entrada al comprobante. */
export function esDocumentoValido(tipo: string, numero?: string): boolean {
  switch (tipo) {
    case 'sin_documento':
      return true;
    case 'dni':
      return esDni(numero || '');
    case 'ruc':
      return esRuc(numero || '');
    case 'ce':
      return esCarneExtranjeria(numero || '');
    case 'pasaporte':
      return esPasaporte(numero || '');
    default:
      return false;
  }
}

/**
 * Dinero: positivo, finito y con dos decimales como maximo.
 *
 * Comparar contra el redondeo no sirve, porque redondea los dos lados y deja
 * pasar 10.123. Lo que hay que medir es cuanto se aleja de un numero entero de
 * centimos, con una tolerancia minima para el ruido del punto flotante.
 */
export function esMonto(valor: unknown, maximo = 100000): boolean {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0 || n > maximo) return false;
  const centimos = n * 100;
  return Math.abs(centimos - Math.round(centimos)) < 1e-6;
}

export const redondear = (n: number, decimales = 2) =>
  Math.round((n + Number.EPSILON) * 10 ** decimales) / 10 ** decimales;

// --------------------------------------------------------- decoradores de DTO

function decorador(
  nombre: string,
  validar: (valor: any) => boolean,
  mensaje: string,
  opciones?: ValidationOptions,
) {
  return (objeto: object, propiedad: string) => {
    registerDecorator({
      name: nombre,
      target: objeto.constructor,
      propertyName: propiedad,
      options: { message: mensaje, ...opciones },
      validator: { validate: (valor: any) => validar(valor) },
    });
  };
}

export const EsDni = (o?: ValidationOptions) =>
  decorador('esDni', esDni, 'El DNI debe tener 8 digitos', o);

export const EsRuc = (o?: ValidationOptions) =>
  decorador('esRuc', esRuc, 'El RUC no es valido: revisa los 11 digitos', o);

export const EsCelular = (o?: ValidationOptions) =>
  decorador('esCelular', esCelular, 'El celular debe tener 9 digitos y empezar en 9', o);

export const EsMonto = (o?: ValidationOptions) =>
  decorador('esMonto', (v) => esMonto(v), 'El monto no es valido (maximo 2 decimales)', o);
