import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DataExportStatus, Gender, UserStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SearchPaginationQueryDto } from '../../common/dto/pagination.dto';

export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @MaxLength(60) displayName?: string;
  @IsOptional() @IsUUID() avatarFileId?: string;
  @ApiPropertyOptional({ enum: Gender }) @IsOptional() @IsEnum(Gender) gender?: Gender;
  /** YYYY-MM-DD */
  @IsOptional() @IsISO8601({ strict: true }) dateOfBirth?: string;
  @IsOptional() @IsString() @MaxLength(60) district?: string;
  @IsOptional() @IsString() @MaxLength(160) institution?: string;
  @IsOptional() @IsString() @MaxLength(80) educationLevel?: string;
  @IsOptional() @IsIn(['bn', 'en']) preferredLocale?: 'bn' | 'en';
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('4', { each: true }) targetExamIds?: string[];
  @IsOptional() @IsInt() @Min(10) @Max(720) dailyStudyMinutes?: number;
}

export class DeleteAccountDto {
  /** DELETE_ACCOUNT one-time code sent to the account's phone/email. */
  @IsOptional() @Matches(/^\d{6}$/) code?: string;
  /** Alternatively, the current password. */
  @IsOptional() @IsString() @MaxLength(128) password?: string;
  @ApiProperty({ example: 'DELETE' }) @IsIn(['DELETE']) confirm: 'DELETE';
}

export class AdminUserQueryDto extends SearchPaginationQueryDto {
  @ApiPropertyOptional({ enum: UserStatus }) @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsString() @MaxLength(40) role?: string;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: [UserStatus.ACTIVE, UserStatus.SUSPENDED] })
  @IsIn([UserStatus.ACTIVE, UserStatus.SUSPENDED])
  status: UserStatus;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class ProfileResponse {
  @ApiPropertyOptional({ nullable: true }) fullName: string | null;
  @ApiPropertyOptional({ nullable: true }) displayName: string | null;
  @ApiPropertyOptional({ nullable: true }) avatarFileId: string | null;
  @ApiPropertyOptional({ enum: Gender, nullable: true }) gender: Gender | null;
  @ApiPropertyOptional({ nullable: true }) dateOfBirth: string | null;
  @ApiPropertyOptional({ nullable: true }) district: string | null;
  @ApiPropertyOptional({ nullable: true }) institution: string | null;
  @ApiPropertyOptional({ nullable: true }) educationLevel: string | null;
  @ApiProperty() preferredLocale: string;
  @ApiProperty({ type: [String] }) targetExamIds: string[];
  @ApiProperty() dailyStudyMinutes: number;
}

export class MeResponse {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiProperty() phoneVerified: boolean;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty() hasPassword: boolean;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiProperty({ type: ProfileResponse }) profile: ProfileResponse;
  @ApiProperty({ type: [String] }) roles: string[];
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiProperty() createdAt: Date;
}

export class DataExportResponse {
  @ApiProperty() id: string;
  @ApiProperty({ enum: DataExportStatus }) status: DataExportStatus;
  @ApiPropertyOptional({ nullable: true }) downloadUrl?: string | null;
  @ApiPropertyOptional({ nullable: true }) expiresAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class AdminUserResponse {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) phone: string | null;
  @ApiPropertyOptional({ nullable: true }) email: string | null;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiPropertyOptional({ nullable: true }) fullName: string | null;
  @ApiProperty({ type: [String] }) roles: string[];
  @ApiPropertyOptional({ nullable: true }) lastLoginAt: Date | null;
  @ApiProperty() createdAt: Date;
}
