import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ENTITLEMENT_KEY } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { EntitlementsService } from './entitlements.service';

/** Enforces @RequireEntitlement(feature) using server-side entitlement records. */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const feature = this.reflector.getAllAndOverride<string>(ENTITLEMENT_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) throw AppError.unauthorized();
    await this.entitlements.assert(user.id, feature);
    return true;
  }
}
