export interface AuthUser {
  id: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
}

export interface RequestContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    rawBody?: Buffer;
    id?: string | number | object;
  }
}
