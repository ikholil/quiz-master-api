import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject, Logger, Optional } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppError } from '../errors/app-error';
import { ErrorReporter } from '../monitoring/error-reporter';

interface ErrorPayload {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/** Converts every thrown error into the standard error envelope. Never leaks stack traces or internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(@Optional() @Inject(ErrorReporter) private readonly reporter?: ErrorReporter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const payload = this.toPayload(exception);
    const requestId = req?.id ? String(req.id) : undefined;

    if (payload.status >= 500) {
      this.logger.error(
        { err: exception, requestId, path: req?.originalUrl, method: req?.method },
        exception instanceof Error ? exception.message : 'Unhandled error',
      );
      this.reporter?.report(exception, { requestId, path: req?.originalUrl, userId: req?.user?.id });
    }

    if (res.headersSent) return;
    res.status(payload.status).json({
      success: false,
      error: { code: payload.code, message: payload.message, ...(payload.details !== undefined ? { details: payload.details } : {}) },
      meta: { requestId },
    });
  }

  private toPayload(exception: unknown): ErrorPayload {
    if (exception instanceof AppError) {
      return { status: exception.status, code: exception.code, message: exception.message, details: exception.details };
    }
    if (exception instanceof ThrottlerException) {
      return { status: 429, code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please slow down' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as string | { message?: string | string[]; error?: string; code?: string };
      const message = typeof body === 'string' ? body : Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? exception.message);
      const code = (typeof body === 'object' && body.code) || httpCode(status);
      return { status, code, message };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return { status: 409, code: 'UNIQUE_CONSTRAINT', message: 'A record with the same unique value already exists', details: { target: exception.meta?.target } };
        case 'P2025':
          return { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
        case 'P2003':
          return { status: 400, code: 'INVALID_REFERENCE', message: 'A referenced record does not exist' };
        case 'P2034':
          return { status: 409, code: 'CONCURRENT_MODIFICATION', message: 'The resource was modified concurrently; please retry' };
      }
    }
    if (exception instanceof Prisma.PrismaClientUnknownRequestError || exception instanceof Prisma.PrismaClientKnownRequestError) {
      const msg = exception.message;
      if (msg.includes('violates check constraint')) {
        return { status: 422, code: 'CONSTRAINT_VIOLATION', message: 'The request violates a data integrity rule' };
      }
    }
    if (exception instanceof SyntaxError && 'body' in (exception as object)) {
      return { status: 400, code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 402:
      return 'PAYMENT_REQUIRED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
  }
}
