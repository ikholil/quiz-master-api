import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Job } from 'bullmq';
import type { Request } from 'express';
import {
  AdminOnly,
  Authenticated,
  CurrentUser,
  Public,
  ReqContext,
} from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelope } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { JOBS, QUEUES, workers } from '../../queue/queue.constants';
import { CoursesModule } from '../courses/courses.module';
import { PERMISSIONS } from '../rbac/permissions';
import { AdminPaymentQueryDto, InitiatePaymentDto, PaymentResponse, RefundDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Get('providers')
  providers() {
    return this.payments.availableProviders();
  }

  @Authenticated()
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Start a payment; open redirectUrl in a browser / custom tab' })
  @ApiEnvelope(PaymentResponse, { status: 201 })
  initiate(
    @CurrentUser() u: AuthUser,
    @Body() dto: InitiatePaymentDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (key !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw AppError.badRequest(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be 8-100 URL-safe characters',
      );
    return this.payments.initiate(u, dto, key);
  }

  @Authenticated()
  @Get()
  mine(@CurrentUser() u: AuthUser, @Query() q: PaginationQueryDto) {
    return this.payments.mine(u.id, q);
  }

  @Authenticated()
  @Get(':id')
  @ApiEnvelope(PaymentResponse)
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(u.id, id);
  }

  @Authenticated()
  @Post(':id/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-check status with the provider after returning from checkout' })
  @ApiEnvelope(PaymentResponse)
  verify(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.verifyForUser(u.id, id);
  }

  /** Provider IPN/webhook. Authenticity is checked by the provider's signature, not by a bearer token. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/:provider')
  @HttpCode(200)
  webhook(@Param('provider') provider: string, @Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.payments.receiveWebhook(provider, req.headers, req.rawBody, body ?? {});
  }
}

@ApiTags('Admin · Payments')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @AdminOnly(PERMISSIONS.PAYMENTS_READ)
  list(@Query() q: AdminPaymentQueryDto) {
    return this.payments.adminList(q);
  }

  @Get(':id')
  @AdminOnly(PERMISSIONS.PAYMENTS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.adminGet(id);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.PAYMENTS_READ)
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.confirm(id, 'reconcile');
  }

  @Post(':id/refunds')
  @AdminOnly(PERMISSIONS.PAYMENTS_REFUND)
  refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.payments.refund(id, dto, u, ctx);
  }

  @Post('reconcile')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.PAYMENTS_READ)
  reconcile() {
    return this.payments.reconcile();
  }
}

@Processor(QUEUES.PAYMENTS, { concurrency: 5 })
export class PaymentsProcessor extends WorkerHost {
  constructor(private readonly payments: PaymentsService) {
    super();
  }
  async process(job: Job): Promise<unknown> {
    if (job.name === JOBS.PROCESS_WEBHOOK)
      return this.payments.confirm(job.data.paymentId as string, 'webhook').then((p) => p.status);
    if (job.name === JOBS.RECONCILE_PAYMENTS) return this.payments.reconcile();
    return undefined;
  }
}

@Module({
  imports: [CoursesModule],
  controllers: [PaymentsController, AdminPaymentsController],
  providers: [PaymentsService, ...workers(PaymentsProcessor)],
  exports: [PaymentsService],
})
export class PaymentsModule {}
