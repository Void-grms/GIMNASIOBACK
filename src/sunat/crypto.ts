import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';

export function claveSunat(): Buffer {
  const key = Buffer.from(process.env.SUNAT_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32)
    throw new ServiceUnavailableException(
      'Falta configurar el cifrado privado de SUNAT en el servidor',
    );
  return key;
}
export function cifrar(texto: string, contexto: string): string {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', claveSunat(), iv);
  c.setAAD(Buffer.from('sunat-beta:' + contexto));
  const data = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64'),
    c.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(':');
}
export function descifrar(texto: string, contexto: string): string {
  const [version, iv, tag, data] = texto.split(':');
  if (version !== 'v1' || !iv || !tag || !data)
    throw new Error('Contenido privado no reconocido');
  const d = createDecipheriv(
    'aes-256-gcm',
    claveSunat(),
    Buffer.from(iv, 'base64'),
  );
  d.setAAD(Buffer.from('sunat-beta:' + contexto));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    d.update(Buffer.from(data, 'base64')),
    d.final(),
  ]).toString('utf8');
}
