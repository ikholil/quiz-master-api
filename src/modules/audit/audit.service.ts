import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuditQueryDto } from './audit.dto';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ctx?: RequestContext;
}

const SENSITIVE_KEYS = /password|token|secret|otp|code|hash|apikey|authorization/i;

/** Removes secrets from audit snapshots so logs never contain credentials. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value instanceof Prisma.Decimal) return value.toString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1),
      ]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Records an audit entry. Pass a transaction client to make the audit record part of the same unit of work. */
  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    const data: Prisma.AuditLogCreateInput = {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before === undefined ? undefined : (redact(entry.before) as Prisma.InputJsonValue),
      after: entry.after === undefined ? undefined : (redact(entry.after) as Prisma.InputJsonValue),
      metadata: entry.metadata ? (redact(entry.metadata) as Prisma.InputJsonValue) : undefined,
      ipAddress: entry.ctx?.ip,
      userAgent: entry.ctx?.userAgent,
      requestId: entry.ctx?.requestId,
    };
    if (tx) {
      await client.auditLog.create({ data });
      return;
    }
    // Outside a transaction, audit failures must not break the user-facing operation, but must be visible.
    await client.auditLog
      .create({ data })
      .catch((err: Error) => this.logger.error(`Audit write failed: ${err.message}`));
  }

  async list(q: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      actorId: q.actorId,
      entityType: q.entityType,
      entityId: q.entityId,
      action: q.action ? { startsWith: q.action } : undefined,
      createdAt:
        q.from || q.to
          ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined }
          : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: q.sortOrder }, ...pageArgs(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }
}
