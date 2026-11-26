import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PERMISSIONS_KEY } from '../../../common/decorators/auth.decorators';
import { AppError } from '../../../common/errors/app-error';

/** Enforces @RequirePermissions / @AdminOnly. All listed permissions are required. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) throw AppError.unauthorized();
    const missing = required.filter((p) => !user.permissions.includes(p));
    if (missing.length)
      throw AppError.forbidden('You do not have permission to perform this action', 'PERMISSION_DENIED');
    return true;
  }
}
