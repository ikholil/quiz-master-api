import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientPlatform, OtpPurpose, UserStatus } from '@prisma/client';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;

export class DeviceInfoDto {
  @ApiPropertyOptional({ enum: ClientPlatform })
  @IsOptional()
  @IsEnum(ClientPlatform)
  platform?: ClientPlatform;

  @IsOptional() @IsString() @MaxLength(128) deviceId?: string;
  @IsOptional() @IsString() @MaxLength(128) deviceName?: string;
}

export class RequestOtpDto {
  /** Bangladeshi mobile number (01XXXXXXXXX / +8801XXXXXXXXX) or email address. */
  @IsString() @MaxLength(254) identifier: string;

  @ApiProperty({ enum: [OtpPurpose.LOGIN, OtpPurpose.VERIFY_EMAIL, OtpPurpose.VERIFY_PHONE, OtpPurpose.RESET_PASSWORD, OtpPurpose.DELETE_ACCOUNT] })
  @IsIn([OtpPurpose.LOGIN, OtpPurpose.VERIFY_EMAIL, OtpPurpose.VERIFY_PHONE, OtpPurpose.RESET_PASSWORD, OtpPurpose.DELETE_ACCOUNT])
  purpose: OtpPurpose;
}

export class VerifyOtpDto extends DeviceInfoDto {
  @IsString() @MaxLength(254) identifier: string;
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code: string;
}

export class RegisterEmailDto extends DeviceInfoDto {
  @IsEmail() @MaxLength(254) email: string;
  @Matches(PASSWORD_RULE, { message: 'password must be 8-128 characters with at least one letter and one digit' })
  password: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName: string;
}

export class VerifyEmailDto extends DeviceInfoDto {
  @IsEmail() @MaxLength(254) email: string;
  @Matches(/^\d{6}$/) code: string;
}

export class PasswordLoginDto extends DeviceInfoDto {
  /** Email or phone number */
  @IsString() @MaxLength(254) identifier: string;
  @IsString() @Length(1, 128) password: string;
}

export class RefreshDto {
  @IsString() @Length(20, 200) refreshToken: string;
}

export class ResetPasswordDto {
  @IsString() @MaxLength(254) identifier: string;
  @Matches(/^\d{6}$/) code: string;
  @Matches(PASSWORD_RULE, { message: 'password must be 8-128 characters with at least one letter and one digit' })
  newPassword: string;
}

export class ChangePasswordDto {
  /** Required when the account already has a password. */
  @IsOptional() @IsString() @MaxLength(128) currentPassword?: string;
  @Matches(PASSWORD_RULE, { message: 'password must be 8-128 characters with at least one letter and one digit' })
  newPassword: string;
}

export class OtpRequestResponse {
  @ApiProperty() sent: boolean;
  @ApiProperty() cooldownSeconds: number;
  @ApiProperty() expiresInSeconds: number;
  @ApiPropertyOptional({ description: 'Development only' }) devCode?: string;
}

export class AuthUserSummary {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiPropertyOptional({ nullable: true }) fullName: string | null;
  @ApiProperty({ type: [String] }) roles: string[];
  @ApiProperty({ type: [String] }) permissions: string[];
}

export class TokenResponse {
  @ApiProperty() accessToken: string;
  @ApiProperty() accessTokenExpiresAt: string;
  @ApiProperty() refreshToken: string;
  @ApiProperty() refreshTokenExpiresAt: string;
  @ApiProperty() sessionId: string;
  @ApiProperty() isNewUser: boolean;
  @ApiProperty({ type: AuthUserSummary }) user: AuthUserSummary;
}

export class RefreshResponse {
  @ApiProperty() accessToken: string;
  @ApiProperty() accessTokenExpiresAt: string;
  @ApiProperty() refreshToken: string;
  @ApiProperty() refreshTokenExpiresAt: string;
  @ApiProperty() sessionId: string;
}

export class SessionResponse {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ClientPlatform }) platform: ClientPlatform;
  @ApiPropertyOptional({ nullable: true }) deviceName: string | null;
  @ApiPropertyOptional({ nullable: true }) ipAddress: string | null;
  @ApiPropertyOptional({ nullable: true }) userAgent: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() lastSeenAt: Date;
  @ApiProperty() expiresAt: Date;
  @ApiProperty() current: boolean;
}
