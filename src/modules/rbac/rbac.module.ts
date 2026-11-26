import {
  Body,
  Controller,
  Get,
  Global,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { ApiEnvelope } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PERMISSIONS } from './permissions';
import { CreateRoleDto, RoleResponse, SetUserRolesDto, UpdateRoleDto, UserAccessResponse } from './rbac.dto';
import { RbacService } from './rbac.service';

@ApiTags('Admin · Roles & permissions')
@Controller('admin')
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('roles')
  @AdminOnly(PERMISSIONS.ROLES_MANAGE)
  @ApiEnvelope(RoleResponse, { isArray: true })
  listRoles() {
    return this.rbac.listRoles();
  }

  @Get('permissions')
  @AdminOnly(PERMISSIONS.ROLES_MANAGE)
  listPermissions() {
    return this.rbac.listPermissions();
  }

  @Post('roles')
  @AdminOnly(PERMISSIONS.ROLES_MANAGE)
  createRole(@Body() dto: CreateRoleDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.rbac.createRole(dto, user.id, ctx);
  }

  @Patch('roles/:id')
  @AdminOnly(PERMISSIONS.ROLES_MANAGE)
  updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.rbac.updateRole(id, dto, user.id, ctx);
  }

  @Put('users/:id/roles')
  @AdminOnly(PERMISSIONS.ROLES_MANAGE)
  @ApiEnvelope(UserAccessResponse)
  setUserRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserRolesDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.rbac.setUserRoles(id, dto.roles, user.id, ctx);
  }
}

@Global()
@Module({ controllers: [RbacController], providers: [RbacService], exports: [RbacService] })
export class RbacModule {}
