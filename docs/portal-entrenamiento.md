# Entrenamiento del portal

Las sesiones de entrenamiento son independientes de las asistencias, membresías y cobros. Iniciar o finalizar una sesión no registra una entrada o salida del gimnasio.

## API del socio

- `GET /api/portal/workout-sessions/active`: sesión abierta o respuesta vacía.
- `POST /api/portal/workout-sessions`: inicia o devuelve la sesión abierta. Recibe `operationId` UUID y título opcional.
- `GET /api/portal/workout-sessions/:id`: recupera una sesión propia.
- `POST /api/portal/workout-sessions/:id/finish`: finalización repetible.
- `POST /api/portal/workouts`: guarda de 1 a 20 series, con `operationId` UUID y `sessionId` opcional. El mismo UUID con el mismo contenido devuelve la operación existente; contenido diferente se rechaza.
- `PATCH /api/portal/workouts/:id`: corrige una serie propia.
- `DELETE /api/portal/workouts/:id`: borrado lógico repetible. Reenviar una operación borrada devuelve su marca de borrado y no la resucita.
- `GET /api/portal/workouts?pagina=1&limite=10`: historial paginado por días completos.
- `GET /api/portal/progress/:exerciseId?semanas=8`: ventana de 4, 8 o 12 semanas.

La identidad procede de la sesión JWT, nunca de un identificador enviado por el navegador. Las escrituras del entrenamiento se serializan por socio dentro de una transacción. El bloqueo no altera `portalVersion` ni la fecha de modificación del socio. La base impide más de una sesión abierta por socio.

## Compatibilidad y migración

Se añaden `WorkoutSession`, `WorkoutOperation` y columnas opcionales en `WorkoutSet`. Las series históricas conservan sus datos y no reciben horas de sesión inventadas. La migración es aditiva para SQLite y PostgreSQL; no necesita reiniciar ni vaciar la base.

Las nuevas series distinguen fuerza de cardio. En registros históricos sin tipo se interpreta el grupo del ejercicio. El cardio usa minutos y nivel, y se excluye de kilos levantados, volumen de fuerza, 1RM y récords de carga. Las columnas antiguas se conservan para clientes anteriores.

## Verificación

- `npm run build`
- `npm run test:logica`
- `npm run test:training`: base SQLite temporal aislada.
- `npm run test:training-pg`: PostgreSQL local del contenedor de pruebas en 55438. Crea una base con prefijo de prueba y la elimina al finalizar. No acepta una base remota.

La suite cubre migración, reintentos, dos clientes concurrentes, propiedad de datos, corrección, borrado, sesiones y métricas de cardio. El informe local `reports/training-verificacion.json` incluye carga HTTP de 50 y 200 usuarios ficticios con un pool de ocho conexiones. El resultado no acredita los recursos ni la latencia de Railway.

En producción: respaldo verificable antes del despliegue y comprobación posterior de los registros existentes. No hacer pruebas de carga, siembras de ejemplos ni registros de entrenamiento sobre socios reales.
