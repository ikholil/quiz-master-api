import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Authenticated, CurrentUser, Public, ReqContext } from '../../common/decorators/auth.decorators';
import { ApiEnvelope } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import {
  ChangePasswordDto,
  OtpRequestResponse,
  PasswordLoginDto,
  RefreshDto,
  RefreshResponse,
  RegisterEmailDto,
  RequestOtpDto,
  ResetPasswordDto,
  SessionResponse,
  TokenResponse,
  VerifyEmailDto,
  VerifyOtpDto,
} from './auth.dto';
import { AuthService } from './auth.service';

const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a one-time code by SMS (phone) or email' })
  @ApiEnvelope(OtpRequestResponse)
  requestOtp(@Body() dto: RequestOtpDto, @ReqContext() ctx: RequestContext) {
    return this.auth.requestOtp(dto, ctx);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in (or sign up) with a LOGIN one-time code' })
  @ApiEnvelope(TokenResponse)
  verifyOtp(@Body() dto: VerifyOtpDto, @ReqContext() ctx: RequestContext) {
    return this.auth.verifyOtpLogin(dto, ctx);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('email/register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register with email + password; a VERIFY_EMAIL code is sent' })
  @ApiEnvelope(OtpRequestResponse)
  registerEmail(@Body() dto: RegisterEmailDto, @ReqContext() ctx: RequestContext) {
    return this.auth.registerWithEmail(dto, ctx);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('email/verify')
  @HttpCode(200)
  @ApiEnvelope(TokenResponse)
  verifyEmail(@Body() dto: VerifyEmailDto, @ReqContext() ctx: RequestContext) {
    return this.auth.verifyEmail(dto, ctx);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Password sign-in with email or phone' })
  @ApiEnvelope(TokenResponse)
  login(@Body() dto: PasswordLoginDto, @ReqContext() ctx: RequestContext) {
    return this.auth.loginWithPassword(dto, ctx);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token and obtain a new access token' })
  @ApiEnvelope(RefreshResponse)
  refresh(@Body() dto: RefreshDto, @ReqContext() ctx: RequestContext) {
    return this.auth.refresh(dto.refreshToken, ctx);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('password/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset password with a RESET_PASSWORD code; all sessions are revoked' })
  resetPassword(@Body() dto: ResetPasswordDto, @ReqContext() ctx: RequestContext) {
    return this.auth.resetPassword(dto, ctx);
  }

  @Authenticated()
  @Post('password/change')
  @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @ReqContext() ctx: RequestContext) {
    return this.auth.changePassword(user.id, user.sessionId, dto, ctx);
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(200)
  logout(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.auth.logout(user.sessionId, user.id, ctx);
  }

  @Authenticated()
  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentUser() user: AuthUser, @Query('includeCurrent') includeCurrent: string | undefined, @ReqContext() ctx: RequestContext) {
    return this.auth.logoutAll(user.id, user.sessionId, includeCurrent === 'true', ctx);
  }

  @Authenticated()
  @Get('sessions')
  @ApiEnvelope(SessionResponse, { isArray: true })
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id, user.sessionId);
  }

  @Authenticated()
  @Delete('sessions/:id')
  revokeSession(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) {
    return this.auth.revokeSession(user.id, id, ctx);
  }
}
