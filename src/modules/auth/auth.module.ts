import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { LoginGuardService } from './login-guard.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, SessionService, OtpService, LoginGuardService, JwtAuthGuard, PermissionsGuard],
  exports: [SessionService, OtpService, JwtAuthGuard, PermissionsGuard, AuthService],
})
export class AuthModule {}
