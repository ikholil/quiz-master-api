import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';

export class PaginationMeta {
  @ApiProperty() page: number;
  @ApiProperty() pageSize: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
}

export class ResponseMeta {
  @ApiProperty({ required: false }) requestId?: string;
  @ApiProperty({ required: false, type: PaginationMeta }) pagination?: PaginationMeta;
}

export class ErrorBody {
  @ApiProperty({ example: 'VALIDATION_FAILED' }) code: string;
  @ApiProperty() message: string;
  @ApiProperty({ required: false, type: Object }) details?: unknown;
}

export class ErrorEnvelope {
  @ApiProperty({ example: false }) success: false;
  @ApiProperty({ type: ErrorBody }) error: ErrorBody;
  @ApiProperty({ type: ResponseMeta }) meta: ResponseMeta;
}

export class OkResponse {
  @ApiProperty({ example: true }) ok: boolean;
}

/** Documents `{ success: true, data: T, meta }`. */
export function ApiEnvelope<T extends Type<unknown>>(
  model: T,
  opts: { status?: HttpStatus; isArray?: boolean; description?: string } = {},
) {
  const data = opts.isArray
    ? { type: 'array', items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(model, ResponseMeta, PaginationMeta, ErrorEnvelope),
    ApiResponse({
      status: opts.status ?? HttpStatus.OK,
      description: opts.description,
      schema: {
        type: 'object',
        required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', example: true },
          data,
          meta: { $ref: getSchemaPath(ResponseMeta) },
        },
      },
    }),
    ApiResponse({ status: 400, description: 'Validation or domain error', type: ErrorEnvelope }),
  );
}

/** Documents `{ success: true, data: T[], meta: { pagination } }`. */
export function ApiPaginated<T extends Type<unknown>>(model: T) {
  return applyDecorators(
    ApiExtraModels(model, ResponseMeta, PaginationMeta, ErrorEnvelope),
    ApiResponse({
      status: HttpStatus.OK,
      schema: {
        type: 'object',
        required: ['success', 'data', 'meta'],
        properties: {
          success: { type: 'boolean', example: true },
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: {
            type: 'object',
            properties: {
              requestId: { type: 'string' },
              pagination: { $ref: getSchemaPath(PaginationMeta) },
            },
          },
        },
      },
    }),
  );
}
