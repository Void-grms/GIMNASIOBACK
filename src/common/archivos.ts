import { join } from 'path';

/**
 * Donde viven las fotos de los socios. En la PC de recepcion es ./uploads;
 * en un servidor con disco efimero (Railway) apunta a un volumen montado,
 * p. ej. UPLOADS_DIR=/data/uploads, para que las fotos sobrevivan un deploy.
 */
export const carpetaArchivos = () => process.env.UPLOADS_DIR || join(process.cwd(), 'uploads');

/** true cuando la base es PostgreSQL (define funciones que SQLite no tiene). */
export const esPostgres = () => /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '');
