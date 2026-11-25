import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ContentStatus, ImportStatus, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUES } from '../../queue/queue.constants';
import { FilesService } from '../files/files.service';
import { RbacService } from '../rbac/rbac.service';
import { parseImportFile } from './question-import';
import { QuestionsService } from './questions.service';

const MAX_ROWS = 10_000;
const MAX_REPORTED_ERRORS = 500;

/** Imports questions in the background, one transaction per row so a bad row never aborts the batch. */
@Processor(QUEUES.QUESTION_IMPORT, { concurrency: 1 })
export class QuestionImportProcessor extends WorkerHost {
  private readonly logger = new Logger(QuestionImportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly questions: QuestionsService,
    private readonly rbac: RbacService,
  ) {
    super();
  }

  async process(job: Job<{ jobId: string; submitForReview: boolean }>): Promise<unknown> {
    const { jobId, submitForReview } = job.data;
    const record = await this.prisma.questionImportJob.findUnique({ where: { id: jobId } });
    if (!record || record.status === ImportStatus.COMPLETED) return;
    await this.prisma.questionImportJob.update({ where: { id: jobId }, data: { status: ImportStatus.PROCESSING, startedAt: new Date() } });

    try {
      const { body } = await this.files.readBuffer(record.fileId);
      const parsed = parseImportFile(body.toString('utf8'), record.format as 'csv' | 'json');
      if (parsed.rows.length > MAX_ROWS) throw new Error(`Import is limited to ${MAX_ROWS} rows`);

      const access = await this.rbac.getAccess(record.createdById);
      const actor = { id: record.createdById, sessionId: 'import', roles: access.roles, permissions: access.permissions };
      const subjects = new Map((await this.prisma.subject.findMany()).map((s) => [s.slug, s.id]));
      const exams = new Map((await this.prisma.exam.findMany({ select: { id: true, slug: true } })).map((e) => [e.slug, e.id]));
      const topics = new Map(
        (await this.prisma.topic.findMany({ include: { chapter: true } })).map((t) => [`${t.chapter.slug}/${t.slug}`, { id: t.id, subjectId: t.chapter.subjectId }]),
      );

      const errors: Array<{ line: number; errors: string[] }> = [];
      let imported = 0;
      for (const item of parsed.rows) {
        if (!item.row) {
          errors.push({ line: item.line, errors: item.errors });
          continue;
        }
        const r = item.row;
        const subjectId = subjects.get(r.subjectSlug);
        const topic = r.topicPath ? topics.get(r.topicPath) : undefined;
        const rowErrors: string[] = [];
        if (!subjectId) rowErrors.push(`unknown subject "${r.subjectSlug}"`);
        if (r.topicPath && !topic) rowErrors.push(`unknown topic "${r.topicPath}"`);
        if (topic && subjectId && topic.subjectId !== subjectId) rowErrors.push('topic does not belong to subject');
        const examIds = r.examSlugs.map((s) => exams.get(s));
        if (examIds.some((e) => !e)) rowErrors.push(`unknown exam in "${r.examSlugs.join(';')}"`);
        if (rowErrors.length) {
          errors.push({ line: item.line, errors: rowErrors });
          continue;
        }
        try {
          await this.prisma.$transaction(async (tx) => {
            let sourceId: string | undefined;
            if (r.source) {
              const existing = await tx.questionSource.findFirst({ where: { type: r.source.type, title: r.source.title, year: r.source.year ?? null } });
              // Imported previous-year sources are never auto-marked official; an editor must verify them.
              sourceId = existing?.id ?? (await tx.questionSource.create({ data: { ...r.source, isOfficial: false } })).id;
            }
            const created = await this.questions.create(
              {
                type: r.type,
                difficulty: r.difficulty,
                subjectId: subjectId!,
                topicId: topic?.id,
                sourceId,
                examIds: examIds as string[],
                tags: r.tags,
                isDemo: r.isDemo,
                aiGenerated: r.source?.type === 'AI_GENERATED',
                content: r.content as never,
              },
              actor,
              undefined,
              tx,
            );
            if (submitForReview) {
              const q = await tx.question.findUnique({ where: { id: (created as { id: string }).id } });
              await tx.questionVersion.update({ where: { id: q!.latestVersionId! }, data: { status: ContentStatus.IN_REVIEW } });
              await tx.question.update({ where: { id: q!.id }, data: { status: ContentStatus.IN_REVIEW } });
            }
          });
          imported++;
        } catch (err) {
          errors.push({ line: item.line, errors: [(err as Error).message.slice(0, 300)] });
        }
        if ((imported + errors.length) % 100 === 0) {
          await this.prisma.questionImportJob.update({ where: { id: jobId }, data: { importedRows: imported, failedRows: errors.length } });
          await job.updateProgress(Math.round(((imported + errors.length) / parsed.rows.length) * 100));
        }
      }

      await this.prisma.questionImportJob.update({
        where: { id: jobId },
        data: {
          status: ImportStatus.COMPLETED,
          totalRows: parsed.rows.length,
          importedRows: imported,
          failedRows: errors.length,
          errors: errors.slice(0, MAX_REPORTED_ERRORS) as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      this.logger.log(`Import ${jobId}: ${imported} imported, ${errors.length} failed`);
      return { imported, failed: errors.length };
    } catch (err) {
      await this.prisma.questionImportJob.update({
        where: { id: jobId },
        data: { status: ImportStatus.FAILED, errors: [{ line: 0, errors: [(err as Error).message] }] as unknown as Prisma.InputJsonValue, completedAt: new Date() },
      });
      throw err;
    }
  }
}
