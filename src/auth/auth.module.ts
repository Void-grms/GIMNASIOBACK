import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtGuard } from './jwt.guard';
import { IntentosService } from './intentos.service';
import { LoginRateService } from '../common/login-rate.service';
import { LoginRateGuard } from '../common/login-rate.guard';

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'dev-secret-no-usar-en-produccion',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, IntentosService, LoginRateService, LoginRateGuard, { provide: APP_GUARD, useClass: JwtGuard }],
  exports: [AuthService, IntentosService, LoginRateGuard, LoginRateService],
})
export class AuthModule {}
