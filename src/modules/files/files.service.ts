import { Inject, Injectable } from '@nestjs/common';
import { FileVisibility, StoredFile } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppError } from '../../common/errors/app-error';
import { sha256 } from '../../common/utils/crypto.util';
import type { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSIONS } from '../rbac/permissions';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage.driver';

export const FILE_PURPOSES = {
  AVATAR: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 2 * 1024 * 1024, adminOnly: false },
  QUESTION_MEDIA: { mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'], maxBytes: 5 * 1024 * 1024, adminOnly: true },
  MATERIAL: { mimes: ['application/pdf', 'image/jpeg', 'image/png', 'text/plain', 'text/markdown'], maxBytes: 50 * 1024 * 1024, adminOnly: true },
  NOTICE: { mimes: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 20 * 1024 * 1024, adminOnly: true },
  QUESTION_IMPORT: { mimes: ['text/csv', 'application/json', 'text/plain', 'application/vnd.ms-excel'], maxBytes: 20 * 1024 * 1024, adminOnly: true },
  KNOWLEDGE: { mimes: ['text/plain', 'text/markdown', 'text/html', 'application/json', 'application/pdf'], maxBytes: 30 * 1024 * 1024, adminOnly: true },
  SUPPORT_ATTACHMENT: { mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 5 * 1024 * 1024, adminOnly: false },
  DATA_EXPORT: { mimes: ['application/json'], maxBytes: 200 * 1024 * 1024, adminOnly: true },
} as const;

export type FilePurpose = keyof typeof FILE_PURPOSES;

/** Magic-number sniffing so a client cannot upload an executable labelled as image/png. */
function sniffMatches(mime: string, buf: Buffer): boolean {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b);
  switch (mime) {
    case 'image/png':
      return startsWith(0x89, 0x50, 0x4e, 0x47);
    case 'image/jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'image/webp':
      return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
    case 'application/pdf':
      return buf.subarray(0, 5).toString() === '%PDF-';
    case 'image/svg+xml': {
      const head = buf.subarray(0, 2048).toString('utf8');
      return /<svg[\s>]/i.test(head) && !/<script/i.test(buf.toString('utf8'));
    }
    default:
      // Text formats: reject binary content (NUL bytes) in the first 8KB.
      return !buf.subarray(0, 8192).includes(0);
  }
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async upload(
    user: AuthUser | null,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
    purpose: FilePurpose,
    visibility: FileVisibility = FileVisibility.PRIVATE,
  ): Promise<StoredFile> {
    const rules = FILE_PURPOSES[purpose];
    if (!rules) throw AppError.badRequest('INVALID_FILE_PURPOSE', 'Unknown file purpose');
    if (rules.adminOnly && user && !user.permissions.includes(PERMISSIONS.ADMIN_ACCESS)) {
      throw AppError.forbidden('Only staff can upload files for this purpose');
    }
    if (!(rules.mimes as readonly string[]).includes(file.mimetype)) {
      throw AppError.badRequest('UNSUPPORTED_FILE_TYPE', `Allowed types: ${rules.mimes.join(', ')}`);
    }
    if (file.size > rules.maxBytes || file.size > this.cfg.storage.maxUploadBytes) {
      throw AppError.badRequest('FILE_TOO_LARGE', `Maximum size is ${Math.floor(rules.maxBytes / 1024 / 1024)} MB`);
    }
    if (file.size === 0 || !sniffMatches(file.mimetype, file.buffer)) {
      throw AppError.badRequest('FILE_CONTENT_MISMATCH', 'File content does not match its declared type');
    }
    const safeExt = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
    const now = new Date();
    const key = `${purpose.toLowerCase()}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}${safeExt}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    return this.prisma.storedFile.create({
      data: {
        ownerId: user?.id ?? null,
        storageKey: key,
        driver: this.storage.name,
        originalName: file.originalname.slice(0, 255),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum: sha256(file.buffer.toString('binary')),
        visibility,
        purpose,
      },
    });
  }

  /** Internal helper for background jobs (exports, generated documents). */
  async storeGenerated(ownerId: string | null, name: string, mime: string, body: Buffer, purpose: FilePurpose): Promise<StoredFile> {
    const key = `${purpose.toLowerCase()}/${randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await this.storage.put(key, body, mime);
    return this.prisma.storedFile.create({
      data: { ownerId, storageKey: key, driver: this.storage.name, originalName: name, mimeType: mime, sizeBytes: body.length, checksum: sha256(body.toString('binary')), visibility: FileVisibility.PRIVATE, purpose },
    });
  }

  async getMeta(id: string, user: AuthUser | undefined): Promise<StoredFile> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) throw AppError.notFound('File');
    if (!this.canRead(file, user)) throw AppError.notFound('File');
    return file;
  }

  async getDownloadUrl(id: string, user: AuthUser | undefined, ttlSeconds = 600) {
    const file = await this.getMeta(id, user);
    const url = await this.storage.signedUrl(file.storageKey, ttlSeconds, file.originalName);
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), mimeType: file.mimeType, sizeBytes: file.sizeBytes };
  }

  async readBuffer(id: string): Promise<{ file: StoredFile; body: Buffer }> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) throw AppError.notFound('File');
    return { file, body: await this.storage.get(file.storageKey) };
  }

  async readByKey(key: string): Promise<{ body: Buffer; mime: string }> {
    const file = await this.prisma.storedFile.findUnique({ where: { storageKey: key } });
    if (!file) throw AppError.notFound('File');
    return { body: await this.storage.get(key), mime: file.mimeType };
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const file = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!file) throw AppError.notFound('File');
    const isOwner = file.ownerId === user.id;
    if (!isOwner && !user.permissions.includes(PERMISSIONS.FILES_MANAGE)) throw AppError.notFound('File');
    await this.prisma.storedFile.delete({ where: { id } });
    await this.storage.delete(file.storageKey);
  }

  private canRead(file: StoredFile, user: AuthUser | undefined): boolean {
    if (file.visibility === FileVisibility.PUBLIC) return true;
    if (!user) return false;
    return file.ownerId === user.id || user.permissions.includes(PERMISSIONS.FILES_MANAGE) || user.permissions.includes(PERMISSIONS.ADMIN_ACCESS);
  }

  healthy() {
    return this.storage.healthy();
  }
}
