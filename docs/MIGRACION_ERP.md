# Migracion del ERP y activacion gradual del portal

El socio conserva su `codigoERP` para marcar asistencia en recepcion. El acceso al portal se activa por separado, con DNI verificado y un PIN temporal entregado en recepcion o un enlace individual por WhatsApp. El codigo ERP nunca es una contrasena.

## Preparar y revisar

Ejecutar desde la raiz de GIMNASIOBACK, con dependencias instaladas y cliente Prisma generado. El Excel original se lee sin modificarse. Sus celdas son datos: el importador no ejecuta instrucciones, formulas, enlaces ni macros del archivo.

```powershell
npm install
npx prisma generate
npx ts-node scripts/importar-erp.ts --help

# Simulacion sin conectar a ninguna base; informes fuera del repositorio.
npx ts-node scripts/importar-erp.ts `
  --archivo 'C:\ruta\migracion_forcesgym.xlsx' `
  --crear-planes-historicos `
  --report "$env:TEMP\migracion-erp-revision.json"
```

La simulacion es el comportamiento predeterminado, aunque `DATABASE_URL` exista. No instancia Prisma, no consulta la base y no genera PIN, enlaces de activacion ni mensajes. El informe contiene cantidades, nombres de planes, codigos ERP, filas y motivos de incidencias; no contiene nombres de personas, DNI, telefonos, correos ni secretos. `fuenteSHA256` identifica el archivo original exacto para comparar una simulacion con la aplicacion.

Sin `--crear-planes-historicos` ni `--planes`, se informan los planes pendientes de decision y no se permite aplicar. Revisar las incidencias y conservar el mismo archivo, el mismo `--origen` y el mismo mapeo al ejecutar de nuevo. El origen predeterminado es `forcesgym`.

## Elegir los planes

Existen dos alternativas explicitas:

* `--planes 'C:\ruta\planes.json'`: un objeto JSON que relaciona el nombre exacto del ERP con el identificador de un plan existente. Por ejemplo, `{ "PLAN ANTIGUO": "id-del-plan-verificado" }`. La transaccion comprueba que esos identificadores existan.
* `--crear-planes-historicos`: crea variantes por nombre, duracion real inclusiva y costo de la fuente. Cada variante tiene identificador determinista y `activo: false`; sirve para conservar contratos y no aparece disponible para nuevas ventas. Una variante se reutiliza cuando coinciden los tres valores. Es posible usar un mapeo parcial y esta opcion para los nombres restantes.

No se infiere que el nombre de un plan antiguo corresponda al catalogo actual. Las fechas de cada membresia se conservan aunque el plan actual mapeado tenga otra duracion o precio. `precioPagado` conserva el costo historico exportado; no constituye un nuevo cobro.

## Aplicar a una base elegida

Antes de aplicar, verificar la base de destino y disponer de un respaldo recuperable. Probar primero con una base local aislada. El script exige `--apply` y `DATABASE_URL` definida explicitamente en el entorno; no toma por su cuenta una URL del archivo `.env`. El esquema de destino debe estar actualizado con los campos ERP y de activacion del portal.

```powershell
# Elegir deliberadamente una base SQLite local de prueba.
$env:DATABASE_URL = 'file:C:/ruta/fuera-del-repositorio/migracion-prueba.db'
npx prisma db push --skip-generate

npx ts-node scripts/importar-erp.ts `
  --archivo 'C:\ruta\migracion_forcesgym.xlsx' `
  --crear-planes-historicos `
  --report "$env:TEMP\migracion-erp-aplicada.json" `
  --apply

# Una segunda ejecucion con la misma fuente omite los registros existentes.
npx ts-node test/importacion.test.ts
```

Con PostgreSQL, usar su `DATABASE_URL` y el proveedor Prisma configurado por el proyecto antes de generar el cliente. No subir Excel, bases, respaldos ni reportes al repositorio. La primera importacion prepara un hash BCrypt de un secreto aleatorio por socio; puede tardar algunos minutos. Los hashes se calculan antes de abrir la transaccion para acortar el bloqueo de escritura.

La aplicacion crea socios, sus credenciales QR aleatorias, variantes historicas elegidas y membresias validas en una sola transaccion. Si aparece un conflicto de identidad, DNI, identificador de membresia o plan, se revierte la transaccion completa y el informe queda `bloqueado`. Una restriccion o error de base tambien produce rollback. Las filas de historial con fechas o estados ambiguos se omiten y se identifican en el reporte para corregirlas; esto no inventa acceso.

No se crean `Payment`, `Sale`, `Receipt`, `CashClose`, `Consent`, `CheckIn` ni notificaciones. Importar un contrato historico no mueve dinero, no ocupa una numeracion de comprobante, no acredita consentimiento y no registra una visita que la fuente no contiene.

## Identidades y acceso

* `Member.codigoERP` conserva texto y ceros iniciales. Si una celda numerica tiene formato de ceros, ese formato se respeta. Nunca se rellena un DNI incompleto por suposicion.
* Solo un documento de ocho digitos exactos se coloca en `dni`. Los documentos incompletos o distintos se importan como `dni: null`; el original queda en `documentoERP` para revisar en recepcion.
* Solo celulares peruanos completos de nueve digitos empezando en 9, con prefijo 51 opcional, se colocan en `telefono`. Los valores originales de contacto se conservan en notas de la ficha para el personal. Un numero con varios telefonos o texto adicional no habilita WhatsApp. Un celular compartido genera aviso por cada ficha afectada; no prueba que corresponda a la persona.
* Los socios importados tienen `pinCambiado: false`, `pinTemporalHasta: null` y `portalVersion: 0`. `pinHash` corresponde a un secreto impredecible que no se entrega ni se exporta. No existe un PIN inicial conocido para los socios importados: recepcion debe activar su acceso.
* La credencial QR tiene secreto aleatorio independiente por socio. El codigo antiguo se usa para buscar y registrar asistencia por el personal; no autentica el portal.

No se inventan DNIs ni consentimientos. La migracion preserva los datos operativos del ERP; el personal verifica identidad, telefono y los consentimientos correspondientes en el flujo normal de recepcion antes de activar el portal. El importador no genera invitaciones ni envia mensajes por lote.

## Historial, fechas y estados

El formato admitido tiene encabezados en la fila 6 de `Clientes` y `Historial`, y datos desde la fila 7. Las columnas deben coincidir con el archivo exportado; no se asignan por suposicion. Las columnas de ultimo plan derivado de `Clientes` no generan contratos adicionales: el origen de membresias es exclusivamente `Historial`.

La clave importada de membresia es `forcesgym:id:<codigo-membresia-ERP>` si existe un codigo y `forcesgym:ref:<referencia-local>` cuando no existe. Si se especifica otro origen, sustituye el prefijo `forcesgym`. Un identificador repetido es un conflicto, incluso cuando ambas filas parecen iguales. La observacion conserva el codigo original y la referencia local.

Las referencias como `his:1` se generaron durante la exportacion y pueden cambiar si se vuelve a exportar con otro orden. La idempotencia esta garantizada para el mismo archivo y origen. Para una exportacion diferente, comparar hashes, referencias e identidades antes de aplicar: el script bloquea claves incompatibles, pero una referencia nueva para el mismo contrato podria crear un duplicado que requiere conciliacion externa.

Las fechas son dias del negocio normalizados a medianoche UTC, segun `src/common/fechas.ts`. Se aceptan fechas Excel, seriales Excel con calendario 1900/1904, textos `DD/MM/YYYY`, `YYYY-MM-DD` y el ISO de medianoche `YYYY-MM-DDT00:00:00.000Z`. Se conservan inicio y ultimo dia valido inclusivo. Una fecha faltante, imposible o un fin anterior al inicio no se corrige a hoy.

El importador normaliza los namespaces SpreadsheetML, las relaciones internas absolutas y las fechas XML `t="d"` en memoria para que ExcelJS pueda leer la exportacion. No escribe una copia alterada del Excel original.

| Estado ERP | Estado importado | Asistencia |
| --- | --- | --- |
| Activo | activa | Conserva fechas; las reglas normales tambien verifican vigencia y socio activo. |
| Vencido | vencida | Conserva contrato historico y no habilita acceso, aunque una fecha exportada sea contradictoria. |
| Traspaso u otro valor | Se omite con aviso | Requiere revision antes de crear un contrato. |

No se convierte un contrato vencido en activo porque sus fechas coincidan con el dia actual. La fecha de creacion de la fila importada corresponde a esta migracion; no se reconstruye la hora original de venta ni la contabilidad del ERP.

En el archivo revisado hay 2.185 socios, 107 documentos pendientes, 2.041 celulares con formato valido y 63 numeros compartidos. El historial contiene 7.021 filas: 7.010 preparadas y 11 omitidas (10 problemas de fechas y un Traspaso). Existen 151 codigos de membresia no vacios y unicos; las demas filas usan referencias locales. La opcion de variantes historicas prepara 339 planes inactivos. Estos numeros sirven para conciliar esta exportacion exacta, no como reglas fijas para futuros archivos.

## Idempotencia y correcciones

Repetir el mismo archivo no sobrescribe contactos, PIN, activaciones, secretos QR ni el estado operativo corregido de una membresia. Las fichas existentes se reconocen por codigo ERP y se comprueba identidad original; un DNI ya vinculado a otra ficha bloquea todo. La importacion no fusiona socios automaticamente. Si se corrige el nombre o el documento original del ERP, revisar la conciliacion antes de reimportar, porque la comprobacion puede reportar conflicto y no decide cual identidad es correcta.

Los avisos no son autorizaciones de acceso ni comprobantes. Las once membresias omitidas se pueden corregir en una copia de trabajo del export fuera del repositorio y conciliar antes de reimportar; no cambiar las referencias de las demas filas. Un nuevo hash de fuente debe revisarse explicitamente.

Las pruebas de `test/importacion.test.ts` usan un XLSX anonimo en un directorio temporal y una base simulada: validan ceros, DNI nulo, duplicados, fechas, estados, compatibilidad XML/ISO, lectura sin DB, planes inactivos, rollback e idempotencia. No leen los datos personales del Excel real.
