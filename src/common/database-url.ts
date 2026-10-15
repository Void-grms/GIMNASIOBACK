/** Un pool por proceso, limitado tambien cuando Railway ve muchos nucleos. */
export function databaseUrl(url = process.env.DATABASE_URL || '') {
  if (!url) return undefined;
  const postgres = /^postgres(ql)?:\/\//i.test(url);
  const size = process.env.DB_POOL_SIZE || (postgres ? '8' : '1');
  if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 32) {
    throw new Error('DB_POOL_SIZE debe estar entre 1 y 32');
  }
  // No se reescribe la ruta de los archivos SQLite (puede ser relativa).
  const [base, params = ''] = url.split('?');
  const query = new URLSearchParams(params);
  if (!query.has('connection_limit')) query.set('connection_limit', size);
  if (!query.has('pool_timeout')) query.set('pool_timeout', '10');
  if (postgres && !query.has('connect_timeout')) query.set('connect_timeout', '10');
  return `${base}?${query}`;
}
