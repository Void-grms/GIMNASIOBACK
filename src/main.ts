import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { carpetaArchivos } from './common/archivos';

async function bootstrap() {
  // En un servidor publico, arrancar con los secretos de desarrollo seria
  // firmar tokens y QR con una clave que esta en el repositorio.
  if (process.env.NODE_ENV === 'production') {
    const faltan = ['DATABASE_URL', 'JWT_SECRET', 'QR_SECRET'].filter((v) => !process.env[v]);
    if (faltan.length) throw new Error(`Faltan variables de entorno en produccion: ${faltan.join(', ')}`);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Detras del proxy de Railway la IP real llega en X-Forwarded-For. Sin esto
  // el limite de intentos de login se aplicaria a todos los usuarios juntos.
  // En la PC de recepcion no se activa: ahi esa cabecera la podria falsificar
  // cualquiera para saltarse el limite.
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  }

  app.setGlobalPrefix('api', { exclude: ['uploads/(.*)'] });

  // Las fotos de los socios viven en disco y se sirven como archivos estaticos.
  app.useStaticAssets(carpetaArchivos(), { prefix: '/uploads' });

  // Las fotos llegan en base64 y no entran en el limite de 100 kb por defecto.
  app.useBodyParser('json', { limit: '6mb' });

  app.enableCors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(','),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      // Un campo que el DTO no declara es un error del cliente, no algo que
      // haya que ignorar en silencio: asi no se cuelan datos sin validar.
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const port = Number(process.env.PORT || 4000);
  await app.listen(port, '0.0.0.0');
  console.log(`API del gimnasio escuchando en el puerto ${port} (/api)`);
}
bootstrap();
