import { Injectable } from '@nestjs/common';
import { Prisma, PublishStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { parseIsoDate } from '../../common/utils/date.util';
import { decToNumber } from '../../common/utils/marks.util';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ChapterDto,
  SetMappingsDto,
  SubjectDto,
  SyllabusVersionDto,
  TopicDto,
  TopicRelationDto,
  UpdateNodeDto,
} from './syllabus.dto';

@Injectable()
export class SyllabusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────── Read ─────────

  listSubjects() {
    return this.prisma.subject.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  async subjectTree(subjectId: string) {
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      include: {
        chapters: { orderBy: { sortOrder: 'asc' }, include: { topics: { orderBy: { sortOrder: 'asc' } } } },
      },
    });
    if (!subject) throw AppError.notFound('Subject');
    return subject;
  }

  async getTopic(topicId: string) {
    const topic = await this.prisma.topic.findUnique({
      where: { id: topicId },
      include: {
        chapter: { include: { subject: true } },
        outgoing: { include: { to: { select: { id: true, name: true, nameBn: true } } } },
        incoming: { include: { from: { select: { id: true, name: true, nameBn: true } } } },
      },
    });
    if (!topic) throw AppError.notFound('Topic');
    return {
      id: topic.id,
      name: topic.name,
      nameBn: topic.nameBn,
      description: topic.description,
      chapter: { id: topic.chapter.id, name: topic.chapter.name },
      subject: { id: topic.chapter.subject.id, name: topic.chapter.subject.name },
      prerequisites: topic.incoming.filter((r) => r.type === 'PREREQUISITE').map((r) => r.from),
      related: [
        ...topic.outgoing.filter((r) => r.type === 'RELATED').map((r) => r.to),
        ...topic.incoming.filter((r) => r.type === 'RELATED').map((r) => r.from),
      ],
    };
  }

  /** Current published syllabus of an exam as a subject → chapter → topic tree with weights. */
  async currentForExam(examId: string, admin = false) {
    const version = await this.prisma.syllabusVersion.findFirst({
      where: {
        examId,
        isCurrent: true,
        status: admin ? undefined : PublishStatus.PUBLISHED,
        exam: admin ? undefined : { status: PublishStatus.PUBLISHED },
      },
    });
    if (!version) throw AppError.notFound('Syllabus');
    return this.tree(version.id, admin);
  }

  async listVersions(examId: string, admin = false) {
    return this.prisma.syllabusVersion.findMany({
      where: { examId, status: admin ? undefined : PublishStatus.PUBLISHED },
      orderBy: [{ isCurrent: 'desc' }, { effectiveFrom: 'desc' }],
      include: { _count: { select: { topicMappings: true } } },
    });
  }

  async tree(versionId: string, admin = false) {
    const version = await this.prisma.syllabusVersion.findUnique({
      where: { id: versionId },
      include: {
        topicMappings: {
          include: { topic: { include: { chapter: { include: { subject: true } } } } },
        },
      },
    });
    if (!version || (!admin && version.status !== PublishStatus.PUBLISHED))
      throw AppError.notFound('Syllabus');

    type TopicNode = {
      id: string;
      name: string;
      nameBn: string | null;
      weight: number;
      marks: number | null;
      sort: number;
    };
    type ChapterNode = { id: string; name: string; nameBn: string | null; sort: number; topics: TopicNode[] };
    type SubjectNode = {
      id: string;
      name: string;
      nameBn: string | null;
      sort: number;
      totalMarks: number;
      chapters: Map<string, ChapterNode>;
    };
    const subjects = new Map<string, SubjectNode>();
    for (const m of version.topicMappings) {
      const t = m.topic;
      const c = t.chapter;
      const s = c.subject;
      if (!subjects.has(s.id))
        subjects.set(s.id, {
          id: s.id,
          name: s.name,
          nameBn: s.nameBn,
          sort: s.sortOrder,
          totalMarks: 0,
          chapters: new Map(),
        });
      const sn = subjects.get(s.id)!;
      if (!sn.chapters.has(c.id))
        sn.chapters.set(c.id, { id: c.id, name: c.name, nameBn: c.nameBn, sort: c.sortOrder, topics: [] });
      const marks = decToNumber(m.marks);
      sn.totalMarks += marks ?? 0;
      sn.chapters
        .get(c.id)!
        .topics.push({
          id: t.id,
          name: t.name,
          nameBn: t.nameBn,
          weight: decToNumber(m.weight) ?? 0,
          marks,
          sort: t.sortOrder,
        });
    }
    const bySort = <T extends { sort: number; name: string }>(a: T, b: T) =>
      a.sort - b.sort || a.name.localeCompare(b.name);
    return {
      versionId: version.id,
      examId: version.examId,
      label: version.label,
      effectiveFrom: version.effectiveFrom,
      stageId: version.stageId,
      status: version.status,
      isCurrent: version.isCurrent,
      topicCount: version.topicMappings.length,
      subjects: [...subjects.values()].sort(bySort).map(({ sort: _s, chapters, ...s }) => ({
        ...s,
        totalMarks: Math.round(s.totalMarks * 100) / 100,
        chapters: [...chapters.values()].sort(bySort).map(({ sort: _c, topics, ...c }) => ({
          ...c,
          topics: topics.sort(bySort).map(({ sort: _t, ...t }) => t),
        })),
      })),
    };
  }

  // ───────── Admin: curriculum ─────────

  async createSubject(dto: SubjectDto, actorId: string, ctx: RequestContext) {
    const s = await this.prisma.subject.create({ data: dto });
    await this.audit.record({
      actorId,
      action: 'syllabus.subject.create',
      entityType: 'Subject',
      entityId: s.id,
      after: dto,
      ctx,
    });
    return s;
  }
  async updateSubject(id: string, dto: UpdateNodeDto, actorId: string, ctx: RequestContext) {
    const { description: _d, ...data } = dto;
    const s = await this.prisma.subject.update({ where: { id }, data });
    await this.audit.record({
      actorId,
      action: 'syllabus.subject.update',
      entityType: 'Subject',
      entityId: id,
      after: dto,
      ctx,
    });
    return s;
  }
  async createChapter(dto: ChapterDto, actorId: string, ctx: RequestContext) {
    const c = await this.prisma.chapter.create({ data: dto });
    await this.audit.record({
      actorId,
      action: 'syllabus.chapter.create',
      entityType: 'Chapter',
      entityId: c.id,
      after: dto,
      ctx,
    });
    return c;
  }
  async updateChapter(id: string, dto: UpdateNodeDto, actorId: string, ctx: RequestContext) {
    const { description: _d, ...data } = dto;
    const c = await this.prisma.chapter.update({ where: { id }, data });
    await this.audit.record({
      actorId,
      action: 'syllabus.chapter.update',
      entityType: 'Chapter',
      entityId: id,
      after: dto,
      ctx,
    });
    return c;
  }
  async createTopic(dto: TopicDto, actorId: string, ctx: RequestContext) {
    const t = await this.prisma.topic.create({ data: dto });
    await this.audit.record({
      actorId,
      action: 'syllabus.topic.create',
      entityType: 'Topic',
      entityId: t.id,
      after: dto,
      ctx,
    });
    return t;
  }
  async updateTopic(id: string, dto: UpdateNodeDto, actorId: string, ctx: RequestContext) {
    const t = await this.prisma.topic.update({ where: { id }, data: dto });
    await this.audit.record({
      actorId,
      action: 'syllabus.topic.update',
      entityType: 'Topic',
      entityId: id,
      after: dto,
      ctx,
    });
    return t;
  }

  async addRelation(dto: TopicRelationDto, actorId: string, ctx: RequestContext) {
    if (dto.fromTopicId === dto.toTopicId)
      throw AppError.badRequest('INVALID_RELATION', 'A topic cannot relate to itself');
    if (dto.type === 'PREREQUISITE' && (await this.reaches(dto.toTopicId, dto.fromTopicId))) {
      throw AppError.badRequest('CYCLIC_PREREQUISITE', 'This prerequisite would create a cycle');
    }
    const r = await this.prisma.topicRelationship.upsert({
      where: { fromTopicId_toTopicId_type: dto },
      create: dto,
      update: {},
    });
    await this.audit.record({
      actorId,
      action: 'syllabus.relation.add',
      entityType: 'TopicRelationship',
      entityId: `${dto.fromTopicId}:${dto.toTopicId}`,
      after: dto,
      ctx,
    });
    return r;
  }

  async removeRelation(dto: TopicRelationDto, actorId: string, ctx: RequestContext) {
    await this.prisma.topicRelationship.deleteMany({ where: dto });
    await this.audit.record({
      actorId,
      action: 'syllabus.relation.remove',
      entityType: 'TopicRelationship',
      entityId: `${dto.fromTopicId}:${dto.toTopicId}`,
      before: dto,
      ctx,
    });
    return { ok: true };
  }

  /** True if `target` is reachable from `start` via PREREQUISITE edges (fromTopic → toTopic). */
  private async reaches(start: string, target: string): Promise<boolean> {
    const seen = new Set<string>([start]);
    let frontier = [start];
    while (frontier.length) {
      const edges = await this.prisma.topicRelationship.findMany({
        where: { fromTopicId: { in: frontier }, type: 'PREREQUISITE' },
        select: { toTopicId: true },
      });
      frontier = [];
      for (const e of edges) {
        if (e.toTopicId === target) return true;
        if (!seen.has(e.toTopicId)) {
          seen.add(e.toTopicId);
          frontier.push(e.toTopicId);
        }
      }
    }
    return false;
  }

  // ───────── Admin: syllabus versions ─────────

  async createVersion(dto: SyllabusVersionDto, actorId: string, ctx: RequestContext) {
    const exam = await this.prisma.exam.findUnique({ where: { id: dto.examId } });
    if (!exam) throw AppError.notFound('Exam');
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await tx.syllabusVersion.create({
        data: {
          examId: dto.examId,
          stageId: dto.stageId,
          label: dto.label,
          notes: dto.notes,
          effectiveFrom: dto.effectiveFrom ? parseIsoDate(dto.effectiveFrom.slice(0, 10)) : undefined,
        },
      });
      if (dto.copyFromVersionId) {
        const src = await tx.examTopicMapping.findMany({
          where: { syllabusVersionId: dto.copyFromVersionId, examId: dto.examId },
        });
        await tx.examTopicMapping.createMany({
          data: src.map((m) => ({
            examId: dto.examId,
            syllabusVersionId: v.id,
            topicId: m.topicId,
            weight: m.weight,
            marks: m.marks,
          })),
        });
      }
      await this.audit.record(
        {
          actorId,
          action: 'syllabus.version.create',
          entityType: 'SyllabusVersion',
          entityId: v.id,
          after: dto,
          ctx,
        },
        tx,
      );
      return v;
    });
    return version;
  }

  async setMappings(versionId: string, dto: SetMappingsDto, actorId: string, ctx: RequestContext) {
    const version = await this.prisma.syllabusVersion.findUnique({ where: { id: versionId } });
    if (!version) throw AppError.notFound('Syllabus version');
    const topicIds = [...new Set(dto.items.map((i) => i.topicId))];
    if (topicIds.length !== dto.items.length)
      throw AppError.badRequest('DUPLICATE_TOPIC', 'Each topic may appear once');
    const existing = await this.prisma.topic.count({ where: { id: { in: topicIds } } });
    if (existing !== topicIds.length)
      throw AppError.badRequest('UNKNOWN_TOPIC', 'One or more topics do not exist');

    await this.prisma.$transaction(async (tx) => {
      if (dto.replace)
        await tx.examTopicMapping.deleteMany({
          where: { syllabusVersionId: versionId, topicId: { notIn: topicIds } },
        });
      for (const item of dto.items) {
        await tx.examTopicMapping.upsert({
          where: { syllabusVersionId_topicId: { syllabusVersionId: versionId, topicId: item.topicId } },
          create: {
            examId: version.examId,
            syllabusVersionId: versionId,
            topicId: item.topicId,
            weight: new Prisma.Decimal(item.weight),
            marks: item.marks,
          },
          update: { weight: new Prisma.Decimal(item.weight), marks: item.marks },
        });
      }
      await this.audit.record(
        {
          actorId,
          action: 'syllabus.mappings.set',
          entityType: 'SyllabusVersion',
          entityId: versionId,
          metadata: { count: dto.items.length, replace: !!dto.replace },
          ctx,
        },
        tx,
      );
    });
    return this.tree(versionId, true);
  }

  async setStatus(versionId: string, status: PublishStatus, actorId: string, ctx: RequestContext) {
    const version = await this.prisma.syllabusVersion.findUnique({
      where: { id: versionId },
      include: { _count: { select: { topicMappings: true } } },
    });
    if (!version) throw AppError.notFound('Syllabus version');
    if (status === PublishStatus.PUBLISHED && version._count.topicMappings === 0) {
      throw AppError.badRequest('SYLLABUS_EMPTY', 'Map at least one topic before publishing');
    }
    const v = await this.prisma.syllabusVersion.update({
      where: { id: versionId },
      data: { status, isCurrent: status === PublishStatus.ARCHIVED ? false : undefined },
    });
    await this.audit.record({
      actorId,
      action: `syllabus.version.${status.toLowerCase()}`,
      entityType: 'SyllabusVersion',
      entityId: versionId,
      ctx,
    });
    return v;
  }

  /** Marks a published version as the exam's current syllabus (unique partial index guarantees one). */
  async makeCurrent(versionId: string, actorId: string, ctx: RequestContext) {
    const version = await this.prisma.syllabusVersion.findUnique({ where: { id: versionId } });
    if (!version) throw AppError.notFound('Syllabus version');
    if (version.status !== PublishStatus.PUBLISHED)
      throw AppError.badRequest('SYLLABUS_NOT_PUBLISHED', 'Publish the version first');
    await this.prisma.$transaction(async (tx) => {
      await tx.syllabusVersion.updateMany({
        where: { examId: version.examId, isCurrent: true },
        data: { isCurrent: false },
      });
      await tx.syllabusVersion.update({ where: { id: versionId }, data: { isCurrent: true } });
      await this.audit.record(
        {
          actorId,
          action: 'syllabus.version.make_current',
          entityType: 'SyllabusVersion',
          entityId: versionId,
          ctx,
        },
        tx,
      );
    });
    return { ok: true };
  }

  /** Topic weights for the exam's current syllabus (consumed by the adaptive engine). */
  async currentTopicWeights(examId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.examTopicMapping.findMany({
      where: { examId, syllabusVersion: { isCurrent: true, status: PublishStatus.PUBLISHED } },
      select: { topicId: true, weight: true },
    });
    return new Map(rows.map((r) => [r.topicId, decToNumber(r.weight) ?? 0.5]));
  }
}
