import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { map, Observable } from 'rxjs';
import { PageResult } from '../dto/pagination.dto';

export const RAW_RESPONSE_KEY = 'rawResponse';

/**
 * Wraps every JSON response as `{ success: true, data, meta }` so both clients parse a single contract.
 * PageResult instances are unwrapped into `data` + `meta.pagination`.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const raw = Reflect.getMetadata(RAW_RESPONSE_KEY, ctx.getHandler());
    if (raw) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    const requestId = req.id ? String(req.id) : undefined;

    return next.handle().pipe(
      map((body) => {
        if (body instanceof StreamableFile || Buffer.isBuffer(body)) return body;
        if (body instanceof PageResult) {
          return { success: true, data: body.items, meta: { requestId, pagination: body.meta } };
        }
        return { success: true, data: body ?? null, meta: { requestId } };
      }),
    );
  }
}
