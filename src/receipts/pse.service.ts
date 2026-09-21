import { Injectable, Logger } from '@nestjs/common';

export type RespuestaPse = {
  estado: 'no_aplica' | 'pendiente' | 'aceptado' | 'rechazado';
  mensaje?: string;
  hash?: string;
  enlace?: string;
};

/**
 * Adaptador de emision electronica.
 *
 * El gimnasio no firma XML ni habla con SUNAT directamente: eso lo hace un PSE.
 * Aqui vive la forma del pedido; conectar NubeFacT es poner el token en los
 * ajustes. Mientras `pseProveedor` sea "ninguno", el comprobante se emite y se
 * guarda igual, con estado "no_aplica".
 */
@Injectable()
export class PseService {
  private readonly log = new Logger('PSE');

  async enviar(comprobante: any, ajustes: any): Promise<RespuestaPse> {
    if (ajustes.pseProveedor === 'nubefact') return this.nubefact(comprobante, ajustes);

    return {
      estado: 'no_aplica',
      mensaje: 'Emision electronica no configurada. El comprobante quedo guardado en el sistema.',
    };
  }

  /**
   * NubeFacT recibe un JSON y se encarga del XML firmado y del envio.
   *
   * SIN PROBAR CONTRA EL SERVICIO REAL: el token y la URL salen de los ajustes
   * y aqui no hay credenciales. Antes de usarlo en produccion hay que emitir un
   * comprobante de prueba y comparar la respuesta.
   */
  private async nubefact(comprobante: any, ajustes: any): Promise<RespuestaPse> {
    if (!ajustes.pseToken || !ajustes.pseUrl) {
      return { estado: 'pendiente', mensaje: 'Falta el token o la URL del PSE en los ajustes' };
    }

    const cuerpo = {
      operacion: 'generar_comprobante',
      tipo_de_comprobante: comprobante.tipo === 'factura' ? 1 : 2,
      serie: comprobante.serie,
      numero: comprobante.numero,
      sunat_transaction: 1,
      cliente_tipo_de_documento: this.codigoDocumento(comprobante.clienteTipoDoc),
      cliente_numero_de_documento: comprobante.clienteNumDoc || '',
      cliente_denominacion: comprobante.clienteNombre,
      cliente_direccion: comprobante.clienteDireccion || '',
      fecha_de_emision: new Date(comprobante.emitidoAt).toISOString().slice(0, 10),
      moneda: 1,
      porcentaje_de_igv: comprobante.igvTasa * 100,
      total_gravada: comprobante.gravado || 0,
      total_inafecta: comprobante.inafecto || 0,
      total_igv: comprobante.igv || 0,
      total: comprobante.total,
      enviar_automaticamente_a_la_sunat: true,
      items: (comprobante.items || []).map((i: any) => ({
        unidad_de_medida: 'ZZ',
        descripcion: i.descripcion,
        cantidad: i.cantidad,
        valor_unitario: i.valorUnitario,
        precio_unitario: i.precioUnitario,
        subtotal: i.total - i.igv,
        tipo_de_igv: comprobante.igv > 0 ? 1 : 8,
        igv: i.igv,
        total: i.total,
      })),
    };

    try {
      const res = await fetch(ajustes.pseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token token="${ajustes.pseToken}"`,
        },
        body: JSON.stringify(cuerpo),
      });
      const data: any = await res.json().catch(() => ({}));

      if (!res.ok || data.errors) {
        this.log.warn(`PSE rechazo el comprobante: ${data.errors || res.status}`);
        return { estado: 'rechazado', mensaje: String(data.errors || `HTTP ${res.status}`) };
      }
      return {
        estado: data.aceptada_por_sunat ? 'aceptado' : 'pendiente',
        mensaje: data.sunat_description || data.sunat_note || 'Enviado al PSE',
        hash: data.cadena_para_codigo_qr || data.codigo_hash,
        enlace: data.enlace_del_pdf || data.enlace,
      };
    } catch (e: any) {
      // Que se caiga el PSE no puede impedir cobrar: el comprobante queda
      // pendiente y se reintenta despues.
      this.log.error(`No se pudo contactar al PSE: ${e.message}`);
      return { estado: 'pendiente', mensaje: `No se pudo contactar al PSE: ${e.message}` };
    }
  }

  private codigoDocumento(tipo: string): string {
    return { dni: '1', ruc: '6', ce: '4', pasaporte: '7', sin_documento: '0' }[tipo] ?? '0';
  }
}
