import { HttpStatus } from '@nestjs/common';

/**
 * Domain error carrying a stable machine-readable code that clients (Android / Next.js) can switch on.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(entity: string, details?: unknown): AppError {
    return new AppError(`${entity.toUpperCase().replace(/\s+/g, '_')}_NOT_FOUND`, `${entity} not found`, HttpStatus.NOT_FOUND, details);
  }
  static forbidden(message = 'You do not have access to this resource', code = 'FORBIDDEN'): AppError {
    return new AppError(code, message, HttpStatus.FORBIDDEN);
  }
  static conflict(code: string, message: string, details?: unknown): AppError {
    return new AppError(code, message, HttpStatus.CONFLICT, details);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED'): AppError {
    return new AppError(code, message, HttpStatus.UNAUTHORIZED);
  }
  static badRequest(code: string, message: string, details?: unknown): AppError {
    return new AppError(code, message, HttpStatus.BAD_REQUEST, details);
  }
  static tooMany(message: string, details?: unknown): AppError {
    return new AppError('TOO_MANY_REQUESTS', message, HttpStatus.TOO_MANY_REQUESTS, details);
  }
  static paymentRequired(feature: string): AppError {
    return new AppError('ENTITLEMENT_REQUIRED', `An active plan with "${feature}" is required`, HttpStatus.PAYMENT_REQUIRED, {
      feature,
    });
  }
}
