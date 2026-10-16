# Facturación SUNAT: fase de pruebas

El administrador dispone de **Facturación SUNAT** (`/panel/facturacion`). Permite preparar los datos fiscales, custodiar SOL y PFX/P12 cifrados y enviar una boleta o factura ficticia de S/60 al servicio BETA. No crea pagos ni contratos, no modifica asistencias y no utiliza las series de ventas.

La emisión productiva está deshabilitada por código. Tener una respuesta BETA aceptada no acredita un RUC, su régimen, la afectación tributaria, el registro del certificado ni las credenciales productivas. Los campos fiscales empiezan vacíos: la ficha proporcionada no incluye el RUC completo, los tributos afectos ni el domicilio fiscal.

## Elección del motor

Revisión de los repositorios al 16 de octubre de 2026:

| Repositorio | Evaluación para este sistema |
|---|---|
| [MiguelVivar/facturacion-electronica-sunat](https://github.com/MiguelVivar/facturacion-electronica-sunat) | TypeScript y MIT, encaja con Nest. Referencia útil; la cobertura comprobada de resúmenes, bajas y resultados no alcanza para adoptar su flujo completo como motor fiscal. |
| [erickorlando/openinvoiceperu](https://github.com/erickorlando/openinvoiceperu) | Apache 2.0; buena referencia del ciclo completo. Archivado y basado en .NET Framework/IIS; exige otra plataforma para esta aplicación Linux. |
| [thegreenter/greenter](https://github.com/thegreenter/greenter) | Elegido para generar UBL 2.1 y firmar. Dependencias fijadas mediante Composer; PHP CLI privado dentro del mismo servicio Railway. |
| [giansalex/lycet](https://github.com/giansalex/lycet) | API REST basada en Greenter; referencia de arquitectura. Aquí no hace falta desplegar otro servicio ni incorporar su API/autenticación. |

Se utiliza `greenter/xml` 5.3.0 y `greenter/xmldsig` 5.1.0. Ver [NOTICE](../billing-engine/NOTICE.md) para licencias MIT y BSD. El transporte de Greenter no se utiliza: Nest envía SOAP con validación TLS activa, destino BETA fijo, límite de tamaño y plazo de espera. El motor recibe exclusivamente JSON por entrada estándar; no expone otro puerto ni recibe variables de base de datos o SOL.

## Flujo y recuperación

1. El navegador conserva una clave de idempotencia por intento. Una transacción serializa el contador de ensayo por RUC/tipo; las restricciones únicas impiden duplicados.
2. El trabajo persiste en PostgreSQL. Un trabajador obtiene una concesión mediante actualización condicional; dos procesos no deben enviar el mismo trabajo simultáneamente.
3. El XML firmado se guarda cifrado antes del envío. El certificado de prueba es autofirmado y temporal; un certificado cargado se conserva cifrado y queda fijado para ese documento.
4. `sendBill` devuelve el CDR. Solo `ResponseCode=0` y la referencia al documento correcto producen `aceptado_beta`. Un HTTP 200, un ticket o un ZIP recibido por sí solos no acreditan aceptación. Los rechazos se conservan como tales.
5. Ante tiempo agotado o interrupción se conserva el resultado incierto. No se reenvía automáticamente: el administrador puede reintentar el mismo XML y correlativo. Un rechazo definitivo exige revisar y crear otro ensayo.

Los XML y CDR solo los descarga un administrador autenticado. Los secretos nunca se devuelven al navegador. La clave `SUNAT_ENCRYPTION_KEY` debe contener 32 bytes aleatorios en base64 y conservarse en Railway junto con su respaldo privado; perderla impide leer los datos cifrados. No debe cambiarse sin una migración de cifrado. No se incluyen secretos en Git, imágenes ni registros.

## Alcance fiscal y siguiente fase

El perfil fijo del laboratorio es una **operación ficticia gravada al 18%**, no una clasificación del gimnasio. Un RUC 10 no permite deducir el régimen ni la afectación. La aceptación de una factura ficticia tampoco habilita a un contribuyente NRUS para emitir facturas.

Antes de emisión real se requiere completar el RUC de 11 dígitos, razón social y domicilio/ubigeo; confirmar régimen y tributos afectos; comprobar emisor electrónico y certificado registrado; validar el usuario SOL con permisos mínimos; conciliar series y últimos correlativos del ERP; implementar el circuito fiscal de notas/bajas, consulta, conservación y entrega. Las credenciales se ingresan en el panel, nunca por chat.

La [RS 114-2019 y su anexo VI](https://www.sunat.gob.pe/legislacion/superin/2019/anexoVI-114-2019.pdf) permiten el envío individual de boletas. El laboratorio usa ese flujo; todavía no implementa resúmenes diarios, bajas ni notas. La distinción `sendBill`/`sendSummary` y ticket/CDR se documenta en el [manual oficial del programador](https://cpe.sunat.gob.pe/sites/default/files/inline-files/manual_programador%20(1).pdf). Los [servicios oficiales](https://cpe.sunat.gob.pe/sites/default/files/inline-files/servicios%20web%20disponibles%20%281%29.pdf) separan BETA de producción.

La [orientación oficial del NRUS](https://orientacion.sunat.gob.pe/01-concepto-de-nrus-nuevo-rus) y la [RS 340-2017](https://www.sunat.gob.pe/legislacion/superin/2017/340-2017.pdf) deben considerarse al confirmar el régimen. La configuración previa de cobros y PSE sigue siendo independiente del laboratorio. Un registro sin envío electrónico se muestra como recibo interno sin valor tributario; anularlo localmente no constituye una baja SUNAT.

## Operación y validación

El `Dockerfile` incorpora Node 22 y PHP 8.4 en el servicio existente. `railway.json` conserva el paso previo de migración/seed. La migración es aditiva y repetible; no necesita borrar tablas. Se mantiene una réplica por el volumen local existente.

- `npm run test:sunat`: cifrado, validación de RUC y respuestas XML/CDR adversas, sin red.
- `npm run test:sunat-pg`: PostgreSQL local aislado en 55438; verifica migración repetida, concurrencia, permisos, secretos y recuperación. Requiere el contenedor local `forcesgym-concurrency-20261015`; no admite direcciones productivas.
- `npm run build` y compilación del contenedor; comprobación del motor PHP dentro de la imagen.
- Pruebas de navegador con API ficticia a 320, 390 y 1440 px, y comprobación posterior en Railway.

Antes de desplegar se crea un respaldo PostgreSQL verificado y se comparan las huellas de las tablas comerciales. La comprobación BETA real usa documentos ficticios, conserva XML/CDR privados y no registra ventas.
