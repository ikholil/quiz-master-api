import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { ALL_PERMISSIONS, DEFAULT_ROLE, PERMISSIONS, SYSTEM_ROLES } from './permissions';
import { CreateRoleDto, UpdateRoleDto } from './rbac.dto';

export interface UserAccess {
  roles: string[];
  permissions: string[];
}

const ACL_TTL_SECONDS = 300;

@Injectable()
export class RbacService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.syncSystemRoles().catch((err: Error) =>
      this.logger.error(`Permission sync failed: ${err.message}`),
    );
  }

  /** Ensures every catalogue permission and system role exists. System role permissions are reconciled. */
  async syncSystemRoles(): Promise<void> {
    for (const key of ALL_PERMISSIONS) {
      await this.prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const perms = await this.prisma.permission.findMany();
    const byKey = new Map(perms.map((p) => [p.key, p.id]));
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const role = await this.prisma.role.upsert({
        where: { key },
        update: { name: def.name, description: def.description, isSystem: true },
        create: { key, name: def.name, description: def.description, isSystem: true },
      });
      await this.prisma.$transaction([
        this.prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
        this.prisma.rolePermission.createMany({
          data: def.permissions.map((p) => ({ roleId: role.id, permissionId: byKey.get(p)! })),
          skipDuplicates: true,
        }),
      ]);
    }
  }

  async getAccess(userId: string): Promise<UserAccess> {
    const cacheKey = `acl:${userId}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached) as UserAccess;

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    const access: UserAccess = {
      roles: userRoles.map((ur) => ur.role.key),
      permissions: [
        ...new Set(userRoles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key))),
      ],
    };
    await this.redis.set(cacheKey, JSON.stringify(access), 'EX', ACL_TTL_SECONDS).catch(() => undefined);
    return access;
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(`acl:${userId}`).catch(() => undefined);
  }

  async invalidateRole(roleId: string): Promise<void> {
    const users = await this.prisma.userRole.findMany({ where: { roleId }, select: { userId: true } });
    if (users.length) await this.redis.del(...users.map((u) => `acl:${u.userId}`)).catch(() => undefined);
  }

  async assignDefaultRole(userId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { key: DEFAULT_ROLE } });
    if (role) {
      await this.prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId: role.id } },
        update: {},
        create: { userId, roleId: role.id },
      });
    }
  }

  listRoles() {
    return this.prisma.role
      .findMany({
        orderBy: { key: 'asc' },
        include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      })
      .then((roles) =>
        roles.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          userCount: r._count.users,
          permissions: r.permissions.map((p) => p.permission.key).sort(),
        })),
      );
  }

  listPermissions() {
    return ALL_PERMISSIONS.slice().sort();
  }

  async createRole(dto: CreateRoleDto, actorId: string, ctx: RequestContext) {
    this.assertKnownPermissions(dto.permissions);
    const perms = await this.prisma.permission.findMany({ where: { key: { in: dto.permissions } } });
    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          key: dto.key,
          name: dto.name,
          description: dto.description,
          permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
        },
      });
      await this.audit.record(
        { actorId, action: 'role.create', entityType: 'Role', entityId: created.id, after: dto, ctx },
        tx,
      );
      return created;
    });
    return { id: role.id, key: role.key };
  }

  async updateRole(roleId: string, dto: UpdateRoleDto, actorId: string, ctx: RequestContext) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw AppError.notFound('Role');
    if (role.isSystem)
      throw AppError.badRequest(
        'SYSTEM_ROLE_IMMUTABLE',
        'System roles are managed in code and cannot be edited',
      );
    if (dto.permissions) this.assertKnownPermissions(dto.permissions);
    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id: roleId }, data: { name: dto.name, description: dto.description } });
      if (dto.permissions) {
        const perms = await tx.permission.findMany({ where: { key: { in: dto.permissions } } });
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) });
      }
      await this.audit.record(
        {
          actorId,
          action: 'role.update',
          entityType: 'Role',
          entityId: roleId,
          before: { name: role.name, permissions: role.permissions.map((p) => p.permission.key) },
          after: dto,
          ctx,
        },
        tx,
      );
    });
    await this.invalidateRole(roleId);
    return { id: roleId };
  }

  async setUserRoles(userId: string, roleKeys: string[], actorId: string, ctx: RequestContext) {
    if (userId === actorId) throw AppError.badRequest('SELF_ROLE_CHANGE', 'You cannot change your own roles');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw AppError.notFound('User');
    const roles = await this.prisma.role.findMany({ where: { key: { in: roleKeys } } });
    if (roles.length !== new Set(roleKeys).size)
      throw AppError.badRequest('UNKNOWN_ROLE', 'One or more roles do not exist');

    const actorAccess = await this.getAccess(actorId);
    if (roleKeys.includes('SUPER_ADMIN') && !actorAccess.roles.includes('SUPER_ADMIN')) {
      throw AppError.forbidden('Only a super administrator can grant SUPER_ADMIN');
    }
    const before = await this.getAccess(userId);
    if (before.roles.includes('SUPER_ADMIN') && !actorAccess.roles.includes('SUPER_ADMIN')) {
      throw AppError.forbidden('Only a super administrator can modify another super administrator');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({
        data: roles.map((r) => ({ userId, roleId: r.id, grantedBy: actorId })),
      });
      await this.audit.record(
        {
          actorId,
          action: 'user.roles.set',
          entityType: 'User',
          entityId: userId,
          before: before.roles,
          after: roleKeys,
          ctx,
        },
        tx,
      );
    });
    await this.invalidate(userId);
    return this.getAccess(userId);
  }

  private assertKnownPermissions(keys: string[]) {
    const unknown = keys.filter((k) => !ALL_PERMISSIONS.includes(k as (typeof ALL_PERMISSIONS)[number]));
    if (unknown.length)
      throw AppError.badRequest('UNKNOWN_PERMISSION', `Unknown permissions: ${unknown.join(', ')}`);
  }

  static isAdmin(access: UserAccess): boolean {
    return access.permissions.includes(PERMISSIONS.ADMIN_ACCESS);
  }
}
