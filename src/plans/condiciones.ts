import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';

/** Version publica de la oferta; no contiene ni necesita secretos. */
export function versionOferta(plan: {
  id: string; nombre: string; precio: number; duracionDias: number;
  limiteAsistencias?: number | null; descripcion?: string | null;
  requiereEvidencia: boolean; activo: boolean; esPromocion?: boolean;
}): string {
  return createHash('sha256').update(JSON.stringify([
    plan.id, plan.nombre, plan.precio, plan.duracionDias, plan.limiteAsistencias ?? null,
    plan.descripcion ?? null, plan.requiereEvidencia, plan.activo, plan.esPromocion ?? false,
  ])).digest('hex');
}

export function comprobarOferta(plan: Parameters<typeof versionOferta>[0], versionEsperada?: string) {
  if (versionEsperada !== undefined && versionEsperada !== versionOferta(plan)) {
    throw new ConflictException('Las condiciones del plan cambiaron. Vuelve a seleccionar el plan y revisa la oferta antes de confirmar el cobro.');
  }
}

/** Copia de la oferta aceptada; los contratos anteriores conservan limite nulo. */
export type CondicionesPlan = {
  planNombre: string;
  planDescripcion: string | null;
  duracionDiasContratada: number;
  requiereEvidenciaContratada: boolean;
  limiteAsistencias: number | null;
};

export function congelarPlan(plan: {
  nombre: string; descripcion?: string | null; duracionDias: number;
  requiereEvidencia: boolean; limiteAsistencias?: number | null;
}): CondicionesPlan {
  return {
    planNombre: plan.nombre,
    planDescripcion: plan.descripcion ?? null,
    duracionDiasContratada: plan.duracionDias,
    requiereEvidenciaContratada: plan.requiereEvidencia,
    limiteAsistencias: plan.limiteAsistencias ?? null,
  };
}

export function condicionesGuardadas(registro: any): CondicionesPlan | undefined {
  if (!registro.planNombre || !registro.duracionDiasContratada) return undefined;
  return {
    planNombre: registro.planNombre,
    planDescripcion: registro.planDescripcion ?? null,
    duracionDiasContratada: registro.duracionDiasContratada,
    requiereEvidenciaContratada: registro.requiereEvidenciaContratada ?? false,
    limiteAsistencias: registro.limiteAsistencias ?? null,
  };
}

/** Para vistas antiguas que usan membership.plan.nombre, exponer la oferta comprada. */
export function conPlanContratado<T extends { plan?: any }>(membresia: T): T {
  const guardadas = condicionesGuardadas(membresia);
  if (!guardadas || !membresia.plan) return membresia;
  return { ...membresia, plan: {
    ...membresia.plan, nombre: guardadas.planNombre, descripcion: guardadas.planDescripcion,
    duracionDias: guardadas.duracionDiasContratada, requiereEvidencia: guardadas.requiereEvidenciaContratada,
    limiteAsistencias: guardadas.limiteAsistencias,
  } };
}
