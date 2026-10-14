/** El código ERP identifica una ficha; nunca acredita acceso al portal. */
export function leerIdentificador(texto: string): { tipo: 'dni' | 'erp' | 'auto'; valor: string } | null {
  const entrada = texto.trim();
  const prefijo = /^(DNI|ERP):\s*(\d{1,20})$/i.exec(entrada);
  if (prefijo) {
    const tipo = prefijo[1].toLowerCase() as 'dni' | 'erp';
    if (tipo === 'dni' && prefijo[2].length !== 8) return null;
    return { tipo, valor: prefijo[2] };
  }
  return /^\d{1,20}$/.test(entrada) ? { tipo: 'auto', valor: entrada } : null;
}
