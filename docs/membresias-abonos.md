# Abonos y vigencias de membresía

## Dinero y contrato

`Membership.totalContratadoCentimos` congela el precio acordado. Los movimientos nuevos guardan `Payment.montoCentimos`; `monto` sigue disponible para caja y consultas existentes. `precioPagado` conserva su significado anterior de precio definitivo del contrato, no se utiliza como acumulado de abonos.

La cuenta calcula el recibido sumando los pagos del contrato y el saldo como total menos recibido. Un contrato histórico con `totalContratadoCentimos = null` se considera saldado por el precio guardado; nunca se deduce deuda del catálogo actual ni de movimientos ausentes en una importación.

El primer abono permite acceder durante la vigencia contratada. La fecha límite del saldo es inclusiva y elegida por recepción. Su vencimiento produce un aviso; no suspende automáticamente el acceso. Un abono posterior conserva las fechas, las asistencias y el contrato. Los pases diarios se pagan completos.

Cada pago genera su comprobante por el importe de ese movimiento. La descripción identifica el plan y la observación conserva total, recibido, acumulado y saldo al cobrar. Completar el saldo no genera otra venta por el total. Esta función no habilita por sí misma la emisión fiscal ni cambia el régimen del gimnasio.

## Operaciones autorizadas

Todos los endpoints administrativos exigen una sesión vigente de administración o recepción. La identidad del autorizante proviene de la sesión.

- `POST /memberships`: pago completo o `abonoInicial`, `fechaLimiteSaldo`, y opcionalmente `fechaInicio`, `motivoFechas`, `apruebaFechas`. `inicioEsperado` protege la vigencia vista antes de cobrar. Los flujos nuevos envían `operationId` UUID v4.
- `GET /memberships/:id/cuenta`: total, recibido, saldo, plazo, versión e historial.
- `POST /memberships/:id/abonos`: UUID, monto, método y datos del comprobante.
- `GET /memberships/pendientes`: saldos, incluidas las anuladas para revisión; una anulada no admite cargos nuevos.
- `PATCH /memberships/:id/fechas`: UUID, versión esperada, nuevo inicio, motivo y aprobación explícita.
- `POST /memberships/:id/congelamientos`: UUID, versión, fechas inclusivas, motivo y aprobación explícita.
- `GET /portal/cuentas`: solo las cuentas del titular; no devuelve motivos internos ni datos del cajero.

## Fechas y pausas

La fecha real de caja y el comprobante emitido nunca se modifican al ajustar la vigencia. El nuevo fin conserva la duración contratada y los días de pausa aprobados. No se pueden excluir asistencias utilizadas, superponer períodos utilizables ni congelar días que ya tengan entradas permitidas. Las pausas adyacentes se suman; las superpuestas se rechazan.

Una pausa bloquea únicamente ese contrato durante su intervalo y extiende el fin sin reiniciar cuotas. Otro contrato utilizable puede dar acceso. Los ajustes conservan antes/después, usuario, rol, fecha, motivo y aprobación en `MembershipOperation`.

## Consistencia y publicación

El UUID y la huella del contenido se guardan en la misma transacción que el pago o el ajuste. Se bloquea primero al socio, como asistencia. Los reintentos recuperan la operación antes de validar cambios posteriores de oferta o saldo; reutilizar el UUID con otro contenido se rechaza. Los términos aceptados se guardan dentro de la transacción del cobro. La emisión se realiza después y puede recuperarse sin cobrar otra vez.

`membership-accounts.sql` es una migración aditiva e idempotente aplicada antes de `prisma db push`. No actualiza importes ni asigna deudas a contratos anteriores.

Validación local: `npm run build`, `npm run test:cuentas`, `npm run test:cuentas-pg`, `npm run test:membresias` y `npm run test:pase-diario`. Los ensayos usan bases aisladas y datos ficticios.
