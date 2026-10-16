import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const script = () => resolve(process.cwd(), 'billing-engine/engine.php');
export const motorDisponible = () =>
  existsSync(script()) &&
  existsSync(resolve(process.cwd(), 'billing-engine/vendor/autoload.php')) &&
  (process.platform !== 'win32' || !!process.env.SUNAT_PHP_BIN);
export function ejecutarMotor(payload: object): Promise<any> {
  if (!motorDisponible())
    return Promise.reject(
      new Error('El motor privado de firma no esta instalado'),
    );
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.SUNAT_PHP_BIN || 'php', [script()], {
      windowsHide: true,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let bytes = 0,
      finished = false;
    const finish = (error?: Error, value?: any) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolveResult(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('El motor de firma excedio el tiempo limite'));
    }, 15000);
    child.stdout.on('data', (b) => {
      bytes += b.length;
      if (bytes > 3_000_000) {
        child.kill('SIGKILL');
        finish(new Error('Respuesta del motor demasiado grande'));
      } else out.push(b);
    });
    // No se propaga stderr: una biblioteca puede incluir contenido privado en errores.
    child.stderr.on('data', () => {});
    child.on('error', () =>
      finish(new Error('No se pudo iniciar el motor de firma')),
    );
    child.on('close', (code) => {
      try {
        const result = JSON.parse(Buffer.concat(out).toString('utf8'));
        if (code !== 0 || result.error) throw Error();
        finish(undefined, result);
      } catch {
        finish(
          new Error(
            'No se pudo validar el certificado o generar el XML firmado',
          ),
        );
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
