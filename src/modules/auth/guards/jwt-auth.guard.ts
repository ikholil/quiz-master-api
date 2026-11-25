import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/decorators/auth.decorators';
import { AppError } from '../../../common/errors/app-error';
import { RbacService } from '../../rbac/rbac.service';
import { SessionService } from '../session.service';

/**
 * Global authentication guard. Verifies the bearer access token, confirms the session has not been revoked
 * (Redis-cached, so revocation takes effect within seconds) and attaches roles/permissions to the request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    if (!token) {
      if (isPublic) return true;
      throw AppError.unauthorized('Authentication required', 'UNAUTHORIZED');
    }

    let claims;
    try {
      claims = this.sessions.verifyAccessToken(token);
    } catch (err) {
      if (isPublic) return true;
      if (err instanceof TokenExpiredError) throw AppError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
      throw AppError.unauthorized('Invalid access token', 'TOKEN_INVALID');
    }

    if (!(await this.sessions.isSessionActive(claims.sid))) {
      if (isPublic) return true;
      throw AppError.unauthorized('Session has been revoked', 'SESSION_REVOKED');
    }

    const access = await this.rbac.getAccess(claims.sub);
    req.user = { id: claims.sub, sessionId: claims.sid, roles: access.roles, permissions: access.permissions };
    return true;
  }
}
