# Bienvenida al portal y concurrencia

## Recepcion

La guia publica esta en `PORTAL_URL/bienvenida`. Explica el cambio de sistema,
la asistencia con el codigo anterior y el acceso al portal con DNI y PIN.
Se puede compartir la guia sin incluir datos personales ni habilitar cuentas.

En la ficha del socio, verificar identidad, DNI y celular antes de preparar su
invitacion. El mensaje incluye la explicacion y el enlace personal de activacion
(un uso, 24 horas). Abrir WhatsApp sigue siendo una accion manual del personal;
preparar un mensaje no significa que haya sido enviado o recibido.
El socio acepta el consentimiento vigente y elige su PIN en la pantalla de
activacion. El PIN temporal de recepcion sigue disponible para quien lo necesite.

## Protecciones al trabajar simultaneamente

- Verificacion bcrypt nativa asincrona, cuatro trabajos activos y cola acotada
  a 256 por proceso; una sobrecarga devuelve 503 con indicacion de reintentar.
- Limites de acceso compartidos en PostgreSQL: cinco solicitudes/minuto por
  DNI o enlace (diez para login staff); 1.200/minuto por IP compartida. Los
  contadores almacenan huellas, no identificadores en claro; las ventanas
  vencidas hace mas de 24 horas se limpian cada diez minutos. Cinco fallos de
  autenticacion bloquean la cuenta quince minutos.
- Cada resultado de autenticacion vuelve a comprobar hash, version y bloqueo
  dentro de una transaccion. Cambiar credenciales revoca sesiones anteriores.
- Presencia, confirmacion y cierre automatico se serializan por socio en la
  base. Se mantienen los intervalos de 30 segundos y tres minutos.
- Pedidos y ventas toman los mismos locks de inventario en orden. La ultima
  unidad no se vende ni se reserva dos veces; venta, pago y entrega son atomicos.
- Un solo pool Prisma por proceso; PostgreSQL usa ocho conexiones por defecto,
  SQLite una. `DB_POOL_SIZE` permite ajustar entre 1 y 32. Parametros explicitos
  en DATABASE_URL conservan prioridad. Cierre ordenado al terminar el proceso.
- Indices para pagos del socio, avisos de llegada y reservas de productos.

## Verificacion reproducible

Usar exclusivamente PostgreSQL local y datos ficticios. El runner rechaza hosts
externos y nombres de base distintos de `forcesgym_test...`.

```sh
docker run -d --name forcesgym-carga -e POSTGRES_PASSWORD=forcesgym-local-tests -e POSTGRES_DB=forcesgym_test -p 127.0.0.1:55438:5432 postgres:18-alpine
npm ci
npm run build
npm run test:carga
npm run test:auth-concurrencia
npm run test:checkins-concurrencia
```

`test:carga` crea un esquema aislado, genera un cliente PostgreSQL separado en
`reports/`, arranca dos procesos Nest independientes y al terminar elimina solo
su esquema. No reemplaza el cliente SQLite local. `LOAD_DATABASE_URL` permite
elegir otra base local de pruebas. El resumen queda en `reports/carga-200.json`.
Las otras pruebas usan SQLite temporal; auth admite un cliente PostgreSQL local
mediante `PG_TEST_CLIENT` y `PG_TEST_DATABASE_URL`. Los modulos de pruebas de
checkins y pedidos exportan funciones para recibir clientes de una base aislada.

Prueba del 15/10/2026: 200 inicios simultaneos desde una misma IP y 3.000 consultas
de perfil, QR y presencia, repartidas entre dos procesos; cero errores. Dataset
ficticio de 2.200 socios, 7.040 contratos, 6.000 asistencias y 2.000 pagos. p95 de
login 2.737 ms y de consultas 2.428 ms en la maquina local de prueba. Se verifico
ademas el limite compartido entre instancias, ocho carreras de autenticacion,
catorce escenarios de presencia y once grupos de inventario/pedidos (200
solicitudes concurrentes). Los rechazos de stock esperado son errores de negocio.

Estos resultados no miden Internet, recursos de Railway ni todos los endpoints.
No garantizan una cantidad fija de usuarios en produccion. Repetir con el equipo
o recursos equivalentes antes de ampliar el despliegue y observar latencia p95,
errores, CPU, memoria y conexiones; revisar recursos si hay espera sostenida.

## Despliegue y crecimiento

La migracion es aditiva: version de sesiones staff, tabla de limites e indices.
Se prueba dos veces sobre PostgreSQL con el esquema anterior y luego se exige
que el esquema final coincida. Conservar respaldo antes de aplicarla.

El backend actual tiene una replica y volumen local para fotos. Los locks y los
limites ya funcionan entre procesos, pero varias replicas del backend requieren
primero almacenamiento compartido/objetos para las fotos y comprobantes privados.
No aumentar replicas mientras esos archivos dependan del volumen de una sola.
Presupuestar conexiones: replicas por DB_POOL_SIZE mas administracion y respaldos
debe quedar por debajo del max_connections real de PostgreSQL.
