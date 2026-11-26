import { Body, Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { EnrollmentStatus, Payment, Prisma, PublishStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUrl, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminOnly, Authenticated, CurrentUser, Public, ReqContext } from '../../common/decorators/auth.decorators';
import { PageResult, pageArgs, SearchPaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { addDays } from '../../common/utils/date.util';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../rbac/permissions';

export class CourseDto {
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(100) slug: string;
  @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(200) titleBn?: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() coverFileId?: string;
  /** Price in paisa; 0 = free. */
  @IsInt() @Min(0) @Max(100_000_000) priceMinor: number;
  /** Access duration after enrolment (null/omitted = lifetime). */
  @IsOptional() @IsInt() @Min(1) @Max(3660) accessDays?: number;
}

export class UpdateCourseDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) titleBn?: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() coverFileId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) priceMinor?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3660) accessDays?: number;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class LessonDto {
  @IsString() @MinLength(2) @MaxLength(200) title: string;
  @IsInt() @Min(1) @Max(1000) sequence: number;
  @IsOptional() @IsString() @MaxLength(100000) content?: string;
  @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https'] }) videoUrl?: string;
  @IsOptional() @IsUUID() materialId?: string;
  @IsOptional() @IsUUID() mockTemplateId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1440) durationMinutes?: number;
  @IsOptional() @IsBoolean() isFreePreview?: boolean;
}

export class CourseSummary {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiPropertyOptional({ nullable: true }) titleBn: string | null;
  @ApiProperty() priceMinor: number;
  @ApiProperty() currency: string;
  @ApiPropertyOptional({ nullable: true }) accessDays: number | null;
  @ApiProperty() lessonCount: number;
}

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: SearchPaginationQueryDto & { examId?: string }) {
    const where: Prisma.CourseWhereInput = { status: PublishStatus.PUBLISHED, examId: q.examId, title: q.q ? { contains: q.q, mode: 'insensitive' } : undefined };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({ where, include: { _count: { select: { lessons: true } } }, orderBy: { publishedAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.course.count({ where }),
    ]);
    return PageResult.of(
      rows.map((c) => ({ id: c.id, slug: c.slug, title: c.title, titleBn: c.titleBn, priceMinor: c.priceMinor, currency: c.currency, accessDays: c.accessDays, lessonCount: c._count.lessons })),
      total,
      q,
    );
  }

  /** Outline is public; lesson bodies are only included for free previews or enrolled users. */
  async detail(idOrSlug: string, userId?: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const course = await this.prisma.course.findFirst({
      where: { ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }), status: PublishStatus.PUBLISHED },
      include: { lessons: { orderBy: { sequence: 'asc' } } },
    });
    if (!course) throw AppError.notFound('Course');
    const enrollment = userId ? await this.activeEnrollment(userId, course.id) : null;
    const done = userId ? new Set((await this.prisma.lessonProgress.findMany({ where: { userId, lesson: { courseId: course.id } } })).map((p) => p.lessonId)) : new Set<string>();
    return {
      id: course.id,
      slug: course.slug,
      title: course.title,
      titleBn: course.titleBn,
      description: course.description,
      examId: course.examId,
      priceMinor: course.priceMinor,
      currency: course.currency,
      accessDays: course.accessDays,
      enrolled: !!enrollment,
      enrollmentExpiresAt: enrollment?.expiresAt ?? null,
      lessons: course.lessons.map((l) => {
        const open = !!enrollment || l.isFreePreview;
        return {
          id: l.id,
          title: l.title,
          sequence: l.sequence,
          durationMinutes: l.durationMinutes,
          isFreePreview: l.isFreePreview,
          locked: !open,
          completed: done.has(l.id),
          content: open ? l.content : null,
          videoUrl: open ? l.videoUrl : null,
          materialId: open ? l.materialId : null,
          mockTemplateId: open ? l.mockTemplateId : null,
        };
      }),
    };
  }

  async enrollFree(userId: string, courseId: string) {
    const course = await this.prisma.course.findFirst({ where: { id: courseId, status: PublishStatus.PUBLISHED } });
    if (!course) throw AppError.notFound('Course');
    if (course.priceMinor > 0) throw AppError.badRequest('PAYMENT_REQUIRED', 'This course is paid; start a payment with purpose COURSE');
    return this.prisma.$transaction((tx) => this.grantEnrollment(tx, userId, course.id, course.accessDays, null));
  }

  /** Called inside the payment transaction. Idempotent per user/course. */
  async fulfilFromPayment(tx: Tx, payment: Payment) {
    const course = await tx.course.findUnique({ where: { id: payment.referenceId } });
    if (!course) throw AppError.notFound('Course');
    return this.grantEnrollment(tx, payment.userId, course.id, course.accessDays, payment.id);
  }

  async revokeForPayment(tx: Tx, paymentId: string) {
    await tx.enrollment.updateMany({ where: { paymentId, status: EnrollmentStatus.ACTIVE }, data: { status: EnrollmentStatus.CANCELLED } });
  }

  private async grantEnrollment(tx: Tx, userId: string, courseId: string, accessDays: number | null, paymentId: string | null) {
    const existing = await tx.enrollment.findUnique({ where: { userId_courseId: { userId, courseId } } });
    const now = new Date();
    // Re-purchase extends access from the later of now / current expiry.
    const base = existing?.status === EnrollmentStatus.ACTIVE && existing.expiresAt && existing.expiresAt > now ? existing.expiresAt : now;
    const expiresAt = accessDays ? addDays(base, accessDays) : null;
    return tx.enrollment.upsert({
      where: { userId_courseId: { userId, courseId } },
      create: { userId, courseId, paymentId, expiresAt },
      update: { status: EnrollmentStatus.ACTIVE, paymentId: paymentId ?? existing?.paymentId, expiresAt, enrolledAt: existing?.status === EnrollmentStatus.ACTIVE ? undefined : now },
    });
  }

  async myEnrollments(userId: string) {
    const rows = await this.prisma.enrollment.findMany({ where: { userId }, include: { course: { include: { _count: { select: { lessons: true } } } } }, orderBy: { enrolledAt: 'desc' } });
    const progress = await this.prisma.lessonProgress.groupBy({ by: ['lessonId'], where: { userId } });
    const doneIds = new Set(progress.map((p) => p.lessonId));
    const lessons = await this.prisma.lesson.findMany({ where: { courseId: { in: rows.map((r) => r.courseId) } }, select: { id: true, courseId: true } });
    return rows.map((r) => {
      const courseLessons = lessons.filter((l) => l.courseId === r.courseId);
      const completed = courseLessons.filter((l) => doneIds.has(l.id)).length;
      return {
        id: r.id,
        courseId: r.courseId,
        title: r.course.title,
        status: r.expiresAt && r.expiresAt < new Date() ? EnrollmentStatus.EXPIRED : r.status,
        enrolledAt: r.enrolledAt,
        expiresAt: r.expiresAt,
        progressPercent: courseLessons.length ? Math.round((completed / courseLessons.length) * 100) : 0,
      };
    });
  }

  async completeLesson(userId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw AppError.notFound('Lesson');
    if (!lesson.isFreePreview && !(await this.activeEnrollment(userId, lesson.courseId))) throw AppError.forbidden('Enrol in the course first', 'NOT_ENROLLED');
    await this.prisma.lessonProgress.upsert({ where: { userId_lessonId: { userId, lessonId } }, create: { userId, lessonId }, update: {} });
    const [total, done] = await Promise.all([
      this.prisma.lesson.count({ where: { courseId: lesson.courseId } }),
      this.prisma.lessonProgress.count({ where: { userId, lesson: { courseId: lesson.courseId } } }),
    ]);
    if (total && done >= total) {
      await this.prisma.enrollment.updateMany({ where: { userId, courseId: lesson.courseId, completedAt: null }, data: { completedAt: new Date(), status: EnrollmentStatus.COMPLETED } });
    }
    return { lessonId, completedLessons: done, totalLessons: total };
  }

  private activeEnrollment(userId: string, courseId: string) {
    return this.prisma.enrollment.findFirst({
      where: { userId, courseId, status: { in: [EnrollmentStatus.ACTIVE, EnrollmentStatus.COMPLETED] }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
  }

  // ───────── Admin ─────────

  async adminList(q: SearchPaginationQueryDto) {
    const where: Prisma.CourseWhereInput = { title: q.q ? { contains: q.q, mode: 'insensitive' } : undefined };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({ where, include: { _count: { select: { lessons: true, enrollments: true } } }, orderBy: { updatedAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.course.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async create(dto: CourseDto, actorId: string, ctx: RequestContext) {
    const c = await this.prisma.course.create({ data: { ...dto, createdById: actorId } });
    await this.audit.record({ actorId, action: 'course.create', entityType: 'Course', entityId: c.id, after: dto, ctx });
    return c;
  }

  async update(id: string, dto: UpdateCourseDto, actorId: string, ctx: RequestContext) {
    const before = await this.prisma.course.findUnique({ where: { id }, include: { _count: { select: { lessons: true } } } });
    if (!before) throw AppError.notFound('Course');
    if (dto.status === PublishStatus.PUBLISHED && !before._count.lessons) throw AppError.badRequest('COURSE_EMPTY', 'Add lessons before publishing');
    const c = await this.prisma.course.update({
      where: { id },
      data: { ...dto, publishedAt: dto.status === PublishStatus.PUBLISHED && !before.publishedAt ? new Date() : undefined },
    });
    await this.audit.record({ actorId, action: 'course.update', entityType: 'Course', entityId: id, before, after: dto, ctx });
    return c;
  }

  async upsertLesson(courseId: string, dto: LessonDto, actorId: string, ctx: RequestContext) {
    if (!(await this.prisma.course.count({ where: { id: courseId } }))) throw AppError.notFound('Course');
    const l = await this.prisma.lesson.upsert({
      where: { courseId_sequence: { courseId, sequence: dto.sequence } },
      create: { ...dto, courseId },
      update: dto,
    });
    await this.audit.record({ actorId, action: 'course.lesson.upsert', entityType: 'Lesson', entityId: l.id, after: { ...dto, content: dto.content ? '[content]' : undefined }, ctx });
    return l;
  }
}

class CourseQueryDto extends SearchPaginationQueryDto {
  @IsOptional() @IsUUID() examId?: string;
}

@ApiTags('Courses')
@Controller()
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Public()
  @Get('public/courses')
  list(@Query() q: CourseQueryDto) {
    return this.courses.list(q);
  }

  @Public()
  @Get('public/courses/:idOrSlug')
  detail(@Param('idOrSlug') idOrSlug: string, @CurrentUser() u?: AuthUser) {
    return this.courses.detail(idOrSlug, u?.id);
  }

  @Authenticated()
  @Post('courses/:id/enroll')
  enroll(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.courses.enrollFree(u.id, id);
  }

  @Authenticated()
  @Get('courses/enrollments')
  mine(@CurrentUser() u: AuthUser) {
    return this.courses.myEnrollments(u.id);
  }

  @Authenticated()
  @Post('lessons/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.courses.completeLesson(u.id, id);
  }
}

@ApiTags('Admin · Courses')
@Controller('admin/courses')
export class AdminCoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  @AdminOnly(PERMISSIONS.COURSES_MANAGE)
  list(@Query() q: SearchPaginationQueryDto) {
    return this.courses.adminList(q);
  }
  @Post()
  @AdminOnly(PERMISSIONS.COURSES_MANAGE)
  create(@Body() dto: CourseDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.courses.create(dto, u.id, ctx);
  }
  @Patch(':id')
  @AdminOnly(PERMISSIONS.COURSES_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCourseDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.courses.update(id, dto, u.id, ctx);
  }
  @Put(':id/lessons')
  @AdminOnly(PERMISSIONS.COURSES_MANAGE)
  lesson(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LessonDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.courses.upsertLesson(id, dto, u.id, ctx);
  }
}

@Module({ controllers: [CoursesController, AdminCoursesController], providers: [CoursesService], exports: [CoursesService] })
export class CoursesModule {}
