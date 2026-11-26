import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SubscriptionStatus } from '@prisma/client';
import {
  AdminOnly,
  Authenticated,
  CurrentUser,
  Public,
  ReqContext,
} from '../../common/decorators/auth.decorators';
import { ApiEnvelope } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PERMISSIONS } from '../rbac/permissions';
import { EntitlementGuard } from './entitlement.guard';
import { EntitlementsService } from './entitlements.service';
import {
  CreatePlanDto,
  EntitlementResponse,
  GrantEntitlementDto,
  PlanResponse,
  SubscriptionResponse,
  UpdatePlanDto,
} from './subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('Public · Subscription plans')
@Controller('public/plans')
export class PublicPlansController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Public()
  @Get()
  @ApiEnvelope(PlanResponse, { isArray: true })
  list() {
    return this.subs.listPlans();
  }
}

@ApiTags('Subscriptions')
@Authenticated()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subs: SubscriptionsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get('me')
  @ApiEnvelope(SubscriptionResponse, { isArray: true })
  mine(@CurrentUser() user: AuthUser) {
    return this.subs.mySubscriptions(user.id);
  }

  /** Authoritative feature access for the client UI (the backend re-checks on every protected call). */
  @Get('me/entitlements')
  @ApiEnvelope(EntitlementResponse, { isArray: true })
  entitlementsMine(@CurrentUser() user: AuthUser) {
    return this.entitlements.getActive(user.id);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.subs.cancel(user.id, id, ctx);
  }
}

@ApiTags('Admin · Subscriptions')
@Controller('admin')
export class AdminSubscriptionsController {
  constructor(
    private readonly subs: SubscriptionsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get('plans')
  @AdminOnly(PERMISSIONS.PLANS_MANAGE)
  @ApiEnvelope(PlanResponse, { isArray: true })
  plans() {
    return this.subs.listPlans(true);
  }

  @Post('plans')
  @AdminOnly(PERMISSIONS.PLANS_MANAGE)
  @ApiEnvelope(PlanResponse, { status: 201 })
  createPlan(@Body() dto: CreatePlanDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.subs.createPlan(dto, user.id, ctx);
  }

  @Patch('plans/:id')
  @AdminOnly(PERMISSIONS.PLANS_MANAGE)
  @ApiEnvelope(PlanResponse)
  updatePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.subs.updatePlan(id, dto, user.id, ctx);
  }

  @Get('subscriptions')
  @AdminOnly(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  list(
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
    @Query('status') status?: SubscriptionStatus,
  ) {
    return this.subs.adminList(userId, status);
  }

  @Get('users/:id/entitlements')
  @AdminOnly(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  userEntitlements(@Param('id', ParseUUIDPipe) id: string) {
    return this.entitlements.listForUser(id);
  }

  @Post('users/:id/entitlements')
  @AdminOnly(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GrantEntitlementDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.entitlements.adminGrant(id, dto, user.id, ctx);
  }

  @Delete('entitlements/:id')
  @AdminOnly(PERMISSIONS.SUBSCRIPTIONS_MANAGE)
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.entitlements.adminRevoke(id, user.id, ctx);
  }
}

@Global()
@Module({
  controllers: [PublicPlansController, SubscriptionsController, AdminSubscriptionsController],
  providers: [EntitlementsService, SubscriptionsService, EntitlementGuard],
  exports: [EntitlementsService, SubscriptionsService, EntitlementGuard],
})
export class SubscriptionsModule {}
