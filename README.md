# Backend - Sistema de gimnasio

NestJS + Prisma. En desarrollo usa SQLite; para produccion cambia el `provider`
de `prisma/schema.prisma` a `postgresql` y la `DATABASE_URL`.

## Arrancar

```bash
npm install
npx prisma db push      # crea la base y el cliente
npm run db:seed         # planes reales, productos y socios de ejemplo
npm run dev             # http://localhost:4000/api
```

## Endpoints

| Metodo | Ruta | Para que |
| --- | --- | --- |
| POST | `/api/auth/login` | Login del personal |
| GET | `/api/members?q=` | Buscar socios |
| POST | `/api/members` | Alta de socio |
| GET | `/api/members/:id` | Ficha con historial |
| POST | `/api/members/:id/foto` | Foto en base64 desde la webcam |
| GET | `/api/plans` | Planes activos |
| GET | `/api/memberships/preview` | Fechas que tendria la venta |
| POST | `/api/memberships` | Vender o renovar membresia |
| POST | `/api/check-ins/scan` | Registrar movimiento (entrada o salida, decide solo) |
| GET | `/api/check-ins/recent` | Ultimos movimientos |
| GET | `/api/check-ins/inside` | Quienes estan dentro ahora |
| GET | `/api/check-ins/arrivals` | Avisos "estoy entrando" |
| POST | `/api/check-ins/arrivals/:id/confirm` | Confirmar la llegada |
| GET | `/api/cash/summary` | Resumen de caja del rango |
| GET | `/api/cash/payments` | Movimientos filtrables |
| GET | `/api/cash/export` | Descarga CSV para Excel |
| POST | `/api/cash/close` | Arqueo de caja |
| GET | `/api/products` | Catalogo con stock |
| POST | `/api/sales` | Venta de mostrador |
| GET | `/api/notifications/pending` | Avisos de vencimiento por enviar |
| POST | `/api/notifications/:memberId/sent` | Marcar aviso como enviado |
| POST | `/api/portal/login` | Login del socio (DNI + PIN) |
| GET | `/api/portal/me` | Panel del socio |
| PATCH | `/api/portal/me` | Editar contacto y PIN |
| POST | `/api/portal/foto` | Selfie del socio |
| GET | `/api/portal/qr` | Codigo QR rotativo |
| POST | `/api/portal/presence` | Boton entrar/salir del socio |
| GET | `/api/settings` | Datos del negocio y textos legales (publico) |
| PATCH | `/api/settings` | Cambiar regimen, datos fiscales y textos (solo admin) |
| GET | `/api/receipts` | Comprobantes emitidos |
| GET | `/api/receipts/:id` | Comprobante para imprimir |
| POST | `/api/receipts/:id/anular` | Anular con motivo |
| POST | `/api/complaints` | Libro de reclamaciones (publico) |
| GET | `/api/complaints/code/:codigo` | Consulta publica por codigo |
| GET | `/api/complaints` | Bandeja del personal |
| POST | `/api/complaints/:id/respond` | Responder dentro del plazo |
| GET | `/api/members/:id/datos` | Derecho de acceso: copia de sus datos |
| POST | `/api/members/:id/anonimizar` | Derecho de supresion |
| GET | `/api/system/health` | Respaldo, comprobantes pendientes y reclamos por vencer |
| POST | `/api/system/backups` | Respaldar ahora (solo admin) |
| GET | `/api/system/backups/:archivo` | Descargar un respaldo (solo admin) |
| GET | `/api/receipts/pending` | Comprobantes sin confirmar ante SUNAT |
| POST | `/api/receipts/retry-pending` | Reintentar el envio |
| GET | `/api/guests/quota/:memberId` | Cupo de invitados del socio |
| POST | `/api/guests` | Registrar un invitado |
| GET | `/api/guests` | Invitados y cuantos se hicieron socios |
| GET | `/api/portal/exercises` | Catalogo de ejercicios |
| POST | `/api/portal/workouts` | Anotar series con repeticiones y peso |
| GET | `/api/portal/progress/:exerciseId` | Curva de progreso de un ejercicio |
| POST | `/api/portal/health-consent` | Autorizar el registro de peso |
| GET/POST/DELETE | `/api/portal/body` | Peso corporal del socio |
| GET | `/api/dashboard/cohorts` | Retencion por cohorte |
| GET | `/api/dashboard/stats` | KPIs del dia |
| GET | `/api/dashboard/at-risk` | Socios que pagaron y no vienen |

## Reglas de negocio

- La membresia dura 30 dias **calendario contando el dia de inicio**: del 19 de
  setiembre al 18 de octubre.
- La renovacion arranca el **dia siguiente al vencimiento**, no el dia del pago.
  Pasados `DIAS_GRACIA` (7 por defecto) arranca hoy.
- El pase diario siempre es para hoy y no se encola detras de otra membresia.
- El QR rota cada 30 segundos, asi una captura de pantalla compartida caduca.
- El escaneo **alterna entrada y salida** segun donde este el socio. Salir
  siempre se puede, aunque la membresia este vencida.
- Un socio que no marca salida queda cerrado automaticamente a las
  `HORAS_MAX_DENTRO` (6 por defecto).
- Un dia de caja es un dia de **Lima**, no un dia UTC: va de las 05:00 UTC a las
  05:00 UTC del dia siguiente. Sin eso, toda la franja de la noche (la de mas
  movimiento) se contaria en el dia siguiente.

## Reglas fiscales y legales

- El precio de lista **incluye IGV**: el desglose se hace hacia atras, no se suma
  encima. S/ 100 = S/ 84.75 de valor de venta + S/ 15.25 de IGV.
- El regimen (`settings.regimen`) decide todo: NRUS no desglosa IGV ni permite
  factura; RER, RMT y General si.
- Boleta sobre `umbralDocumento` (S/ 700 por defecto): se exige el documento del
  cliente.
- Factura: RUC validado con digito verificador modulo 11, razon social y
  direccion fiscal obligatorias.
- El correlativo se reserva dentro de la transaccion: dos cobros simultaneos no
  pueden repetir numero.
- El emisor se congela en el comprobante: cambiar la razon social manana no
  reescribe los comprobantes de ayer.
- El envio al PSE ocurre fuera de la transaccion. Si el PSE se cae, el cobro ya
  esta registrado y el comprobante queda pendiente.
- Libro de reclamaciones: 15 dias habiles, descontando sabados, domingos y los
  feriados nacionales listados en `common/fechas.ts`.

## Seguridad del acceso

- El PIN del portal se genera al azar (`crypto.randomInt`) y viaja en claro una
  sola vez, en la respuesta del alta. Derivarlo del DNI era regalar la cuenta a
  quien viera el documento.
- `pinCambiado` obliga a cambiarlo: mientras sea falso la sesion dura una hora en
  vez de 30 dias.
- `@nestjs/throttler` limita los logins a 10 (personal) y 5 (socio) por minuto y
  por IP; ademas la cuenta se bloquea 15 minutos tras 5 fallos. Cada intento
  queda en `LoginAttempt`.
- Los mensajes de error no distinguen entre usuario inexistente y clave mala.

## Respaldo

`BackupService` corre a las 03:00 de Lima y usa `VACUUM INTO`, que deja una copia
consistente aunque haya escrituras en curso; copiar el archivo a mano puede
capturar una transaccion a medias. Se conservan 14 copias en `backend/backups/`.
Con PostgreSQL esto no aplica: ahi corresponde un `pg_dump` programado, y el
endpoint lo dice en vez de fingir que respaldo.

## Validacion

`ValidationPipe` corre con `whitelist` y `forbidNonWhitelisted`: un campo que el
DTO no declara devuelve 400 en vez de colarse sin validar. Las validaciones
propias de Peru estan en `common/validadores.ts` (DNI, RUC con digito
verificador, celular, montos) y se usan tanto en los DTO como en los servicios.

## Archivos subidos

Las fotos se guardan en `backend/uploads/socios/` y se sirven en
`/uploads/socios/...`. No entran al repositorio.
