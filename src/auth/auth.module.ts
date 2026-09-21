import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtGuard } from './jwt.guard';
import { IntentosService } from './intentos.service';

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'dev-secret-no-usar-en-produccion',
      signOptions: { expiresIn: '12h' },
    }),
    // El limite por defecto es holgado porque la pantalla de recepcion consulta
    // cada pocos segundos; los endpoints de login lo aprietan con @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 600 }]),
  ],
  controllers: [AuthController],
  providers: [AuthService, IntentosService, { provide: APP_GUARD, useClass: JwtGuard }],
  exports: [AuthService, IntentosService],
})
export class AuthModule {}
