# Planes y asistencias

El administrador gestiona el catalogo mediante `GET /api/plans/admin?estado=activos|inactivos|todos&q=texto`, `POST /api/plans` y `PATCH /api/plans/:id`. Recepcion conserva lectura de planes activos con `GET /api/plans`. La web publica obtiene un catalogo de campos seguros con `GET /api/plans/public`.

Campos editables: nombre, precio (soles, hasta dos decimales, cero permitido), duracionDias, descripcion, requiereEvidencia, orden, activo, esPromocion y limiteAsistencias. Un limite nulo permite acceso sin cupo; un entero positivo limita los dias de asistencia del periodo contratado. Desactivar retira el plan de nuevas ventas sin afectar contratos vigentes ni renovaciones pendientes ya pagadas. Los planes `erp_*` conservan el historial importado y son de solo lectura.

Interdiaria se agrega una sola vez con ID `plan_interdiaria`, precio S/60, vigencia 30 dias y 12 asistencias. El seed no cambia una Interdiaria existente ni recrea este ID tras renombrar o desactivar. Los tres planes de ejemplo iniciales solo se crean si el catalogo esta vacio.

Cada venta congela nombre, descripcion, duracion, requisito de evidencia y cupo. La solicitud Yape congela esas mismas condiciones al solicitarse y el monto original se conserva al aprobar. Cambiar el catalogo no reescribe contratos. Al editar por primera vez un plan nativo, sus contratos anteriores sin snapshot se congelan con su duracion real y sin imponerles cupos. Los contratos importados no reciben actualizaciones retroactivas.

El preview de cobro y los planes del portal incluyen `versionOferta`, una huella SHA-256 de las condiciones materiales. Ambos POST exigen esa version; se comprueba contra el plan bloqueado dentro de la transaccion. Si el catalogo cambio desde la oferta mostrada, se devuelve 409 y no se crea pago ni solicitud. El cliente debe volver a seleccionar y revisar el plan. Aprobar una solicitud Yape ya existente utiliza su snapshot aceptado.

El cupo aumenta solo con una entrada permitida en un nuevo dia de Lima, en la misma transaccion que registra la entrada. Salir, reingresar durante el mismo dia, un escaneo repetido o un intento denegado no consume otro dia. El lock de base por socio protege lectura, contador e insercion entre procesos. Un fallo revierte ambas escrituras. El indice de CheckIn por membershipId/resultado/tipo/timestamp permite comprobar el ingreso del dia sin recorrer la asistencia completa.

Agotar el cupo antes del vencimiento permite que una nueva compra comience hoy. Si el socio ya tiene una renovacion futura encolada, se conserva esa cola y la previsualizacion muestra sus fechas. Un pase diario siempre empieza hoy. La seleccion de contrato para el ingreso y portal excluye las renovaciones futuras mientras haya uno valido hoy.

La migracion `prisma/membership-plans.sql` es aditiva e idempotente; el predeploy la ejecuta antes de verificar el esquema con Prisma. Los registros anteriores conservan cupo nulo y contador cero. No se eliminan tablas, planes, pagos ni contratos.

Validacion local: `npm run test:membresias` utiliza dos clientes SQLite y una base temporal con identidades anonimas. La funcion exportada `probarMembresias(clientes)` permite repetir los escenarios con dos clientes PostgreSQL aislados. Incluye agotamiento, reingresos, rollback, renovacion inmediata, oferta pendiente, cambios de catalogo concurrentes y ventas concurrentes sin solapamiento.
