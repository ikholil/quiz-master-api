import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntitlementSource, SubscriptionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ALL_FEATURES } from './features';

export class PlanFeatureDto {
  @ApiProperty({ enum: ALL_FEATURES }) @IsIn(ALL_FEATURES) featureKey: string;
  /** Per-day limit; omit/null for unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(100000) limitValue?: number | null;
}

export class CreatePlanDto {
  @Matches(/^[a-z0-9_-]{2,40}$/) code: string;
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(80) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  /** Price in paisa (100 = ৳1). */
  @IsInt() @Min(0) @Max(100_000_000) priceMinor: number;
  @IsInt() @Min(1) @Max(3660) durationDays: number;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PlanFeatureDto) features: PlanFeatureDto[];
}

export class UpdatePlanDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(80) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) priceMinor?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3660) durationDays?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PlanFeatureDto) features?: PlanFeatureDto[];
}

export class GrantEntitlementDto {
  @ApiProperty({ enum: ALL_FEATURES }) @IsIn(ALL_FEATURES) featureKey: string;
  @IsOptional() @IsInt() @Min(0) limitValue?: number | null;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class PlanFeatureResponse {
  @ApiProperty() featureKey: string;
  @ApiPropertyOptional({ nullable: true }) limitValue: number | null;
}

export class PlanResponse {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) nameBn: string | null;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() priceMinor: number;
  @ApiProperty() currency: string;
  @ApiProperty() durationDays: number;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: [PlanFeatureResponse] }) features: PlanFeatureResponse[];
}

export class SubscriptionResponse {
  @ApiProperty() id: string;
  @ApiProperty({ enum: SubscriptionStatus }) status: SubscriptionStatus;
  @ApiProperty() planId: string;
  @ApiProperty() planCode: string;
  @ApiProperty() planName: string;
  @ApiPropertyOptional({ nullable: true }) startsAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) endsAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) cancelledAt: Date | null;
}

export class EntitlementResponse {
  @ApiProperty() featureKey: string;
  @ApiPropertyOptional({ nullable: true, description: 'null = unlimited' }) limitValue: number | null;
  @ApiPropertyOptional({ nullable: true }) endsAt: string | null;
  @ApiProperty({ enum: EntitlementSource, isArray: true }) sources: EntitlementSource[];
}
