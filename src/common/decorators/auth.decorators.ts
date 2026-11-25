import { createParamDecorator, ExecutionContext, SetMetadata, applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthUser, RequestContext } from '../types/auth-user';
import { PERMISSIONS, PermissionKey } from '../../modules/rbac/permissions';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const ENTITLEMENT_KEY = 'entitlement';

/** Marks a route as not requiring authentication. An access token, if present, is still parsed. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires all listed permissions. */
export const RequirePermissions = (...permissions: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Admin endpoint: requires `admin.access` plus the listed permissions. */
export const AdminOnly = (...permissions: PermissionKey[]) =>
  applyDecorators(
    RequirePermissions(PERMISSIONS.ADMIN_ACCESS, ...permissions),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Missing or invalid access token' }),
    ApiForbiddenResponse({ description: 'Missing permission' }),
  );

/** Authenticated student endpoint. */
export const Authenticated = () =>
  applyDecorators(ApiBearerAuth(), ApiUnauthorizedResponse({ description: 'Missing or invalid access token' }));

/** Requires an active entitlement for the given feature key (validated server-side). */
export const RequireEntitlement = (feature: string) => SetMetadata(ENTITLEMENT_KEY, feature);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest<Request>().user;
});

export const ReqContext = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return {
    requestId: req.id ? String(req.id) : undefined,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 500),
  };
});

export { UseGuards };
