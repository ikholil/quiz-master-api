import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentPurpose, PaymentStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class InitiatePaymentDto {
  @ApiProperty({ enum: PaymentPurpose }) @IsEnum(PaymentPurpose) purpose: PaymentPurpose;
  /** SubscriptionPlan.id or Course.id */
  @IsUUID() referenceId: string;
  /** Defaults to the configured provider. */
  @IsOptional() @IsString() @MaxLength(30) provider?: string;
}

export class RefundDto {
  /** Omit for a full refund of the remaining amount. */
  @IsOptional() @IsInt() @Min(1) amountMinor?: number;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  /** Keep the purchased access after a full refund (goodwill). */
  @IsOptional() @IsBoolean() keepAccess?: boolean;
}

export class AdminPaymentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus }) @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;
  @ApiPropertyOptional({ enum: PaymentPurpose }) @IsOptional() @IsEnum(PaymentPurpose) purpose?: PaymentPurpose;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() @MaxLength(30) provider?: string;
  @IsOptional() @IsString() @MaxLength(60) merchantTxnId?: string;
}

export class PaymentResponse {
  @ApiProperty() id: string;
  @ApiProperty({ enum: PaymentPurpose }) purpose: PaymentPurpose;
  @ApiProperty() referenceId: string;
  @ApiProperty() provider: string;
  @ApiProperty() merchantTxnId: string;
  @ApiProperty() amountMinor: number;
  @ApiProperty() currency: string;
  @ApiProperty({ enum: PaymentStatus }) status: PaymentStatus;
  @ApiPropertyOptional({ nullable: true, description: 'Open this URL to complete payment (PENDING only)' }) redirectUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) paidAt: Date | null;
  @ApiProperty() refundedMinor: number;
  @ApiProperty() createdAt: Date;
}
