import { Controller, Get, Global, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly } from '../../common/decorators/auth.decorators';
import { ApiPaginated } from '../../common/swagger/api-envelope';
import { PERMISSIONS } from '../rbac/permissions';
import { AuditLogResponse, AuditQueryDto } from './audit.dto';
import { AuditService } from './audit.service';

@ApiTags('Admin · Audit logs')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @AdminOnly(PERMISSIONS.AUDIT_READ)
  @ApiPaginated(AuditLogResponse)
  list(@Query() q: AuditQueryDto) {
    return this.audit.list(q);
  }
}

@Global()
@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
