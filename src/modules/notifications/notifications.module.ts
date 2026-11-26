import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ClientPlatform, NotificationChannel } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AdminOnly, Authenticated, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ApiPaginated } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { workers } from '../../queue/queue.constants';
import { PERMISSIONS } from '../rbac/permissions';
import { MessagingProcessor, NotificationsProcessor } from './notifications.processor';
import { NotificationsService } from './notifications.service';
import { deliveryProviders } from './providers';

class NotificationQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['true', 'false']) unreadOnly?: string;
}

class RegisterDeviceDto {
  @IsString() @MinLength(20) @MaxLength(4096) token: string;
  @ApiProperty({ enum: ClientPlatform }) @IsEnum(ClientPlatform) platform: ClientPlatform;
}

class RemoveDeviceDto {
  @IsString() @MaxLength(4096) token: string;
}

class SegmentDto {
  @IsOptional() @IsBoolean() all?: boolean;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsString() @MaxLength(40) planCode?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10000) @IsUUID('4', { each: true }) userIds?: string[];
}

class BroadcastDto {
  @ValidateNested() @Type(() => SegmentDto) segment: SegmentDto;
  @IsString() @MaxLength(60) type: string;
  @IsString() @MinLength(2) @MaxLength(140) title: string;
  @IsString() @MinLength(2) @MaxLength(1000) body: string;
  @IsOptional() @IsObject() data?: Record<string, unknown>;
  @ApiPropertyOptional({ enum: NotificationChannel, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationChannel, { each: true })
  channels?: NotificationChannel[];
}

export class NotificationResponse {
  @ApiProperty() id: string;
  @ApiProperty() type: string;
  @ApiProperty() title: string;
  @ApiProperty() body: string;
  @ApiPropertyOptional({ type: Object, nullable: true }) data: unknown;
  @ApiPropertyOptional({ nullable: true }) readAt: Date | null;
  @ApiProperty() createdAt: Date;
}

@ApiTags('Notifications')
@Authenticated()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiPaginated(NotificationResponse)
  list(@CurrentUser() user: AuthUser, @Query() q: NotificationQueryDto) {
    return this.notifications.list(user.id, q, q.unreadOnly === 'true');
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post('devices')
  @HttpCode(200)
  registerDevice(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.notifications.registerDevice(user.id, dto.token, dto.platform);
  }

  @Delete('devices')
  removeDevice(@CurrentUser() user: AuthUser, @Body() dto: RemoveDeviceDto) {
    return this.notifications.removeDevice(user.id, dto.token);
  }
}

@ApiTags('Admin · Notifications')
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('broadcast')
  @AdminOnly(PERMISSIONS.NOTIFICATIONS_SEND)
  broadcast(@Body() dto: BroadcastDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    const { segment, ...input } = dto;
    return this.notifications.broadcast(
      segment,
      { ...input, channels: input.channels ?? ['IN_APP', 'PUSH'] },
      user.id,
      ctx,
    );
  }
}

@Global()
@Module({
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [
    NotificationsService,
    ...deliveryProviders,
    ...workers(MessagingProcessor, NotificationsProcessor),
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
