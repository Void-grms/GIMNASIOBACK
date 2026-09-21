/** Textos por defecto. El administrador los reemplaza en Ajustes. */
export const MENSAJE_NUEVO = `¡Hola {nombre}! 🎉 Bienvenido a {gimnasio}.
Tu plan *{plan}* ya esta activo: del {inicio} al *{vence}*.
Pagaste {monto} ({metodo}). Aqui tienes tu {comprobante}: {enlace}
Tu credencial QR esta en el portal: {portal}
¡Te esperamos! 💪`;

export const MENSAJE_RENOVACION = `¡Hola {nombre}! 💪 Gracias por seguir entrenando con nosotros en {gimnasio}.
Renovaste tu plan *{plan}*: vigente del {inicio} al *{vence}*.
Pagaste {monto} ({metodo}). Aqui tienes tu {comprobante}: {enlace}
¡Nos vemos en el gym!`;

export const VARIABLES = [
  '{nombre}', '{gimnasio}', '{plan}', '{inicio}', '{vence}', '{dias}',
  '{monto}', '{metodo}', '{comprobante}', '{enlace}', '{portal}',
];
