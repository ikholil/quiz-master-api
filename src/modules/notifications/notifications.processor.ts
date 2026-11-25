import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationStatus, OtpChannel, OtpPurpose } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { NotificationsService, NotifyInput, BroadcastSegment } from './notifications.service';
import { EMAIL_SENDER, EmailSender, PUSH_SENDER, PushSender, SMS_SENDER, SmsSender } from './providers';

const OTP_TEXT: Record<OtpPurpose, string> = {
  LOGIN: 'লগইন',
  REGISTER: 'রেজিস্ট্রেশন',
  VERIFY_EMAIL: 'ইমেইল যাচাই',
  VERIFY_PHONE: 'মোবাইল যাচাই',
  RESET_PASSWORD: 'পাসওয়ার্ড রিসেট',
  DELETE_ACCOUNT: 'অ্যাকাউন্ট মুছে ফেলা',
};

export function otpMessage(code: string, purpose: OtpPurpose): string {
  return `Quiz Master ${OTP_TEXT[purpose]} কোড: ${code}। ৫ মিনিটের মধ্যে ব্যবহার করুন। কাউকে এই কোড জানাবেন না। / Your code is ${code}. Do not share it.`;
}

/** OTP / transactional email delivery. */
@Processor(QUEUES.MESSAGING, { concurrency: 10 })
export class MessagingProcessor extends WorkerHost {
  constructor(
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case JOBS.SEND_OTP: {
        const { identifier, channel, purpose, code } = job.data as { identifier: string; channel: OtpChannel; purpose: OtpPurpose; code: string };
        const text = otpMessage(code, purpose);
        if (channel === OtpChannel.SMS) await this.sms.send(identifier, text);
        else await this.email.send(identifier, 'Quiz Master verification code', text);
        return;
      }
      case JOBS.SEND_EMAIL: {
        const { to, subject, text, html } = job.data as { to: string; subject: string; text: string; html?: string };
        await this.email.send(to, subject, text, html);
        return;
      }
    }
  }
}

@Processor(QUEUES.NOTIFICATIONS, { concurrency: 5 })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === JOBS.DELIVER_NOTIFICATION) return this.deliver(job.data.notificationId as string);
    if (job.name === JOBS.BROADCAST_NOTIFICATION) return this.broadcast(job.data.segment as BroadcastSegment, job.data.input as NotifyInput);
    return undefined;
  }

  private async deliver(notificationId: string) {
    const n = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: { user: { select: { phone: true, email: true, phoneVerifiedAt: true, emailVerifiedAt: true, deviceTokens: true, status: true } } },
    });
    if (!n || n.status === NotificationStatus.SENT || n.user.status !== 'ACTIVE') return;
    try {
      for (const channel of n.channels) {
        if (channel === NotificationChannel.PUSH && n.user.deviceTokens.length) {
          const data = Object.fromEntries(Object.entries((n.data as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]));
          const { invalidTokens } = await this.push.send(n.user.deviceTokens.map((t) => t.token), n.title, n.body, { ...data, type: n.type, notificationId: n.id });
          if (invalidTokens.length) await this.prisma.deviceToken.deleteMany({ where: { token: { in: invalidTokens } } });
        }
        if (channel === NotificationChannel.EMAIL && n.user.email && n.user.emailVerifiedAt) await this.email.send(n.user.email, n.title, n.body);
        if (channel === NotificationChannel.SMS && n.user.phone && n.user.phoneVerifiedAt) await this.sms.send(n.user.phone, `${n.title}: ${n.body}`);
      }
      await this.prisma.notification.update({ where: { id: n.id }, data: { status: NotificationStatus.SENT, sentAt: new Date(), error: null } });
    } catch (err) {
      await this.prisma.notification.update({ where: { id: n.id }, data: { status: NotificationStatus.FAILED, error: (err as Error).message.slice(0, 500) } });
      throw err;
    }
  }

  private async broadcast(segment: BroadcastSegment, input: NotifyInput) {
    let count = 0;
    for await (const ids of this.notifications.segmentUsers(segment)) {
      for (const id of ids) {
        await this.notifications.notify(id, { ...input, dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${id}` : undefined });
        count++;
      }
    }
    this.logger.log(`Broadcast "${input.title}" delivered to ${count} users`);
    return { count };
  }
}
