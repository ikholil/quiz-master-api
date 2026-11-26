import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly, Authenticated, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { ApiEnvelope, ApiPaginated } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PERMISSIONS } from '../rbac/permissions';
import {
  AdminUserQueryDto,
  AdminUserResponse,
  DataExportResponse,
  DeleteAccountDto,
  MeResponse,
  UpdateProfileDto,
  UpdateUserStatusDto,
} from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Me')
@Authenticated()
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiEnvelope(MeResponse)
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch('profile')
  @ApiEnvelope(MeResponse)
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  @Post('deletion-code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a DELETE_ACCOUNT confirmation code to the verified phone/email' })
  deletionCode(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.users.requestDeletionCode(user.id, ctx);
  }

  @Delete()
  @ApiOperation({ summary: 'Permanently delete the account (requires password or DELETE_ACCOUNT code)' })
  delete(@CurrentUser() user: AuthUser, @Body() dto: DeleteAccountDto, @ReqContext() ctx: RequestContext) {
    return this.users.deleteAccount(user.id, dto, ctx);
  }

  @Post('data-export')
  @ApiOperation({ summary: 'Request a JSON export of all personal data (processed in the background)' })
  @ApiEnvelope(DataExportResponse, { status: 201 })
  export(@CurrentUser() user: AuthUser) {
    return this.users.requestDataExport(user.id);
  }

  @Get('data-export/:id')
  @ApiEnvelope(DataExportResponse)
  exportStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.getDataExport(user.id, id);
  }
}

@ApiTags('Admin · Users')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @AdminOnly(PERMISSIONS.USERS_READ)
  @ApiPaginated(AdminUserResponse)
  list(@Query() q: AdminUserQueryDto) {
    return this.users.adminList(q);
  }

  @Get(':id')
  @AdminOnly(PERMISSIONS.USERS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.adminGet(id);
  }

  @Patch(':id/status')
  @AdminOnly(PERMISSIONS.USERS_MANAGE)
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.users.adminSetStatus(id, dto, user.id, ctx);
  }
}

@Module({
  controllers: [MeController, AdminUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
