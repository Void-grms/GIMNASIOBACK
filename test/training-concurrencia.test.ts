/** Entrenamiento aislado con dos clientes de base, nunca contra datos del gimnasio. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TrainingService } from '../src/training/training.service';
import { RankingService } from '../src/training/ranking.service';
import { hoyLima, sumarDias } from '../src/common/fechas';

export async function probarEntrenamiento(clientes: any[]) {
  const db = clientes[0], servicios = clientes.map(c => new TrainingService(c));
  const [a, b] = servicios;
  const prefix = `training-qa-${randomUUID()}`;
  const miembros = [`${prefix}-a`, `${prefix}-b`];
  const fuerza = `${prefix}-fuerza`, cardio = `${prefix}-cardio`, privado = `${prefix}-privado`;
  let pruebas = 0;
  const ok = (s: string) => { pruebas++; console.log(`ok ${s}`); };
  const dto = (operationId = randomUUID()) => ({ exerciseId: fuerza, operationId, series: [{ repeticiones: 10, pesoKg: 20 }] });
  try {
    await db.member.createMany({ data: miembros.map((id, i) => ({ id, dni: String(89000000 + i), nombres: 'ANONIMO', apellidos: 'PRUEBA', pinHash: 'sin-acceso', pinCambiado: true, portalVersion: 11 })) });
    await db.exercise.createMany({ data: [{ id: fuerza, nombre: 'FUERZA QA', grupo: 'pecho' }, { id: cardio, nombre: 'CARDIO QA', grupo: 'cardio' }, { id: privado, nombre: 'PRIVADO QA', grupo: 'pecho', memberId: miembros[1] }] });

    const socioAntes = await db.member.findUnique({ where: { id: miembros[0] } });
    const operacion = dto();
    const [primera, repetida] = await Promise.all([a.registrar(miembros[0], operacion), b.registrar(miembros[0], operacion)]);
    assert.equal(primera.sets[0].id, repetida.sets[0].id);
    assert.equal(await db.workoutSet.count({ where: { memberId: miembros[0] } }), 1);
    assert.equal((await db.member.findUnique({ where: { id: miembros[0] } })).portalVersion, 11);
    assert.equal((await db.member.findUnique({ where: { id: miembros[0] } })).updatedAt.getTime(), socioAntes.updatedAt.getTime());
    ok('dos clientes concurrentes y el mismo UUID producen una serie sin cambiar la sesion JWT');

    await assert.rejects(a.registrar(miembros[0], { ...operacion, series: [{ repeticiones: 5, pesoKg: 30 }] }), /otros datos/);
    assert.equal(await db.workoutSet.count({ where: { memberId: miembros[0] } }), 1);
    ok('reutilizar UUID con otros datos se rechaza sin modificar lo guardado');

    const escritas = await Promise.all(Array.from({ length: 8 }, (_, i) => servicios[i % 2].registrar(miembros[0], dto())));
    assert.equal(new Set(escritas.map(r => r.sets[0].serie)).size, 8);
    assert.equal(await db.workoutSet.count({ where: { memberId: miembros[0] } }), 9);
    ok('ocho operaciones paralelas distintas conservan orden de series sin numeracion repetida');

    const inicioA = randomUUID(), inicioB = randomUUID();
    const [sa, sb] = await Promise.all([a.iniciarSesion(miembros[0], { operationId: inicioA, titulo: 'Prueba' }), b.iniciarSesion(miembros[0], { operationId: inicioB })]);
    assert.equal(sa.id, sb.id);
    assert.equal(await db.workoutSession.count({ where: { activeMemberId: miembros[0] } }), 1);
    ok('dos pestanas abren un solo entrenamiento y la cuenta lo recupera');

    const enSesion = { ...dto(), sessionId: sa.id };
    const guardada = await a.registrar(miembros[0], enSesion);
    assert.equal((await b.sesionActiva(miembros[0])).series[0].id, guardada.sets[0].id);
    await assert.rejects(b.registrar(miembros[1], { ...dto(), sessionId: sa.id }), /no es tuya/);
    await assert.rejects(a.registrar(miembros[0], { ...dto(), exerciseId: privado }), /no encontrado/);
    await assert.rejects(a.sesionEntrenamiento(miembros[1], sa.id), /no es tuya/);
    await assert.rejects(a.finalizarSesion(miembros[1], sa.id), /no es tuya/);
    await assert.rejects(a.editarSerie(miembros[1], guardada.sets[0].id, { pesoKg: 99 }), /no es tuya/);
    await assert.rejects(a.borrarSerie(miembros[1], guardada.sets[0].id), /no es tuya/);
    ok('sesiones, ejercicios privados, edicion y borrado verifican siempre al dueno');

    const editada = await a.editarSerie(miembros[0], guardada.sets[0].id, { pesoKg: 25 });
    assert.equal(editada.pesoKg, 25);
    assert.equal(editada.repeticiones, 10);
    assert.equal(await db.workoutSet.count({ where: { id: editada.id } }), 1);
    await Promise.all([a.borrarSerie(miembros[0], editada.id), b.borrarSerie(miembros[0], editada.id)]);
    assert((await a.registrar(miembros[0], enSesion)).sets[0].deletedAt);
    assert.equal((await a.sesionActiva(miembros[0])).series.length, 0);
    await assert.rejects(a.editarSerie(miembros[0], editada.id, { pesoKg: 26 }), /eliminada/);
    ok('corregir no duplica, deshacer es repetible y reintentar no resucita series');

    const [finA, finB] = await Promise.all([a.finalizarSesion(miembros[0], sa.id), b.finalizarSesion(miembros[0], sa.id)]);
    assert.equal(finA.endedAt.toISOString(), finB.endedAt.toISOString());
    assert.equal(await a.sesionActiva(miembros[0]), null);
    assert.equal((await a.iniciarSesion(miembros[0], { operationId: inicioB })).id, sa.id);
    assert.equal(await a.sesionActiva(miembros[0]), null);
    await assert.rejects(a.registrar(miembros[0], { ...dto(), sessionId: sa.id }), /finalizo/);
    assert.equal((await a.registrar(miembros[0], enSesion)).sets[0].id, editada.id);
    const nueva = await a.iniciarSesion(miembros[0], { operationId: randomUUID() });
    assert.notEqual(nueva.id, sa.id);
    assert.equal(await db.checkIn.count({ where: { memberId: miembros[0] } }), 0);
    ok('finalizar es repetible, reintentos no abren sesiones nuevas ni consumen asistencias');

    await db.workoutSet.create({ data: { memberId: miembros[0], exerciseId: cardio, fecha: sumarDias(hoyLima(), -1), repeticiones: 15, pesoKg: 4 } });
    const cardioDto = { exerciseId: cardio, operationId: randomUUID(), series: [{ duracionMinutos: 12.5, nivel: 6 }] };
    const cardioGuardado = await a.registrar(miembros[0], cardioDto);
    assert.equal(cardioGuardado.record, false);
    assert.equal(cardioGuardado.mejorNuevo, null);
    assert.equal(cardioGuardado.sets[0].duracionMinutos, 12.5);
    assert.equal((await a.ultimaSesion(miembros[0], cardio)).mejorPeso, null);
    const cardioProgreso = await a.progreso(miembros[0], cardio, '4');
    assert.equal(cardioProgreso.tipo, 'cardio');
    assert.equal(cardioProgreso.mejorMarca, null);
    assert.equal(cardioProgreso.puntos.reduce((t, p) => t + p.minutos, 0), 27.5);
    assert(cardioProgreso.puntos.every(p => !p.volumen && !p.unaRm && !p.mejorPeso));
    const semana = await a.semana(miembros[0]);
    assert.equal(semana.total.volumen, 9 * 200);
    const hist = await a.historial(miembros[0]);
    assert.equal(hist.reduce((t, h) => t + h.volumen, 0), 9 * 200);
    assert.equal(hist.reduce((t, h) => t + h.minutosCardio, 0), 27.5);
    const ranking = await new RankingService(db).paraSocio(miembros[0]);
    assert(ranking.misRecords.every(r => r.ejercicio !== 'CARDIO QA'));
    ok('cardio nuevo e historico usa minutos, sin volumen de fuerza ni records');

    const vieja = await db.workoutSet.create({ data: { memberId: miembros[0], exerciseId: fuerza, fecha: sumarDias(hoyLima(), -57), repeticiones: 1, pesoKg: 100 } });
    assert.equal((await a.progreso(miembros[0], fuerza, '4')).mejorMarca, 20);
    assert.equal((await a.progreso(miembros[0], fuerza, '8')).mejorMarca, 20);
    assert.equal((await a.progreso(miembros[0], fuerza, '12')).mejorMarca, 100);
    await assert.rejects(a.progreso(miembros[0], fuerza, '900'), /4, 8 o 12/);
    const una = await a.historial(miembros[0], undefined, undefined, '1', '1');
    const dos = await a.historial(miembros[0], undefined, undefined, '2', '1');
    assert.equal(una.length, 1); assert.equal(dos.length, 1); assert.notEqual(una[0].dia, dos[0].dia);
    assert((await db.workoutSet.findUnique({ where: { id: vieja.id } })).tipo === null);
    ok('periodos 4/8/12, dias completos paginados y filas historicas sin reclasificar');

    const invalid = { ...dto(), series: [{ repeticiones: 10, pesoKg: 20 }, { repeticiones: 0, pesoKg: 10 }] };
    await assert.rejects(a.registrar(miembros[0], invalid));
    assert.equal(await db.workoutOperation.count({ where: { memberId: miembros[0], operationId: invalid.operationId } }), 0);
    const mismoUuidOtroSocio = await a.registrar(miembros[1], dto(operacion.operationId));
    assert.notEqual(mismoUuidOtroSocio.sets[0].id, primera.sets[0].id);
    ok('fallo revierte el bloque completo y la idempotencia esta aislada por socio');
    return { pruebas };
  } finally {
    await db.member.deleteMany({ where: { id: { in: miembros } } });
    await db.exercise.deleteMany({ where: { id: { in: [fuerza, cardio, privado] } } });
  }
}
