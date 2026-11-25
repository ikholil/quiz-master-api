import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() actorId?: string;
  @IsOptional() @IsString() @MaxLength(64) entityType?: string;
  @IsOptional() @IsString() @MaxLength(64) entityId?: string;
  /** Prefix match, e.g. `question.` */
  @IsOptional() @IsString() @MaxLength(64) action?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class AuditLogResponse {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) actorId: string | null;
  @ApiProperty() action: string;
  @ApiProperty() entityType: string;
  @ApiPropertyOptional({ nullable: true }) entityId: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true }) before: unknown;
  @ApiPropertyOptional({ type: Object, nullable: true }) after: unknown;
  @ApiPropertyOptional({ type: Object, nullable: true }) metadata: unknown;
  @ApiPropertyOptional({ nullable: true }) ipAddress: string | null;
  @ApiPropertyOptional({ nullable: true }) requestId: string | null;
  @ApiProperty() createdAt: Date;
}
