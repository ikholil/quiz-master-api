import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { FileVisibility } from '@prisma/client';
import { IsEnum, IsIn, IsOptional } from 'class-validator';
import type { Response } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { Authenticated, CurrentUser, Public } from '../../common/decorators/auth.decorators';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelope } from '../../common/swagger/api-envelope';
import type { AuthUser } from '../../common/types/auth-user';
import { FILE_PURPOSES, FilePurpose, FilesService } from './files.service';
import { LocalStorageDriver } from './storage/local.driver';
import { S3StorageDriver } from './storage/s3.driver';
import { STORAGE_DRIVER, StorageDriver } from './storage/storage.driver';

interface UploadedBinary {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

class UploadFileDto {
  @ApiProperty({ enum: Object.keys(FILE_PURPOSES) })
  @IsIn(Object.keys(FILE_PURPOSES))
  purpose: FilePurpose;

  @ApiPropertyOptional({ enum: FileVisibility })
  @IsOptional()
  @IsEnum(FileVisibility)
  visibility?: FileVisibility;
}

export class StoredFileResponse {
  @ApiProperty() id: string;
  @ApiProperty() originalName: string;
  @ApiProperty() mimeType: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({ enum: FileVisibility }) visibility: FileVisibility;
  @ApiProperty() purpose: string;
  @ApiProperty() createdAt: Date;
}

export class DownloadUrlResponse {
  @ApiProperty() url: string;
  @ApiProperty() expiresAt: string;
  @ApiProperty() mimeType: string;
  @ApiProperty() sizeBytes: number;
}

@ApiTags('Files')
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  @Authenticated()
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 60 * 1024 * 1024, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'purpose'],
      properties: { file: { type: 'string', format: 'binary' }, purpose: { type: 'string', enum: Object.keys(FILE_PURPOSES) }, visibility: { type: 'string', enum: Object.values(FileVisibility) } },
    },
  })
  @ApiEnvelope(StoredFileResponse, { status: 201 })
  async upload(@UploadedFile() file: UploadedBinary | undefined, @Body() dto: UploadFileDto, @CurrentUser() user: AuthUser) {
    if (!file) throw AppError.badRequest('FILE_REQUIRED', 'A file field is required');
    const stored = await this.files.upload(user, file, dto.purpose, dto.visibility);
    return { id: stored.id, originalName: stored.originalName, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, visibility: stored.visibility, purpose: stored.purpose, createdAt: stored.createdAt };
  }

  @Public()
  @Get(':id/url')
  @ApiEnvelope(DownloadUrlResponse)
  url(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: AuthUser) {
    return this.files.getDownloadUrl(id, user);
  }

  @Authenticated()
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.files.remove(id, user);
    return { ok: true };
  }

  /** Signed download endpoint for the local storage driver. */
  @Public()
  @RawResponse()
  @Get('download/:token')
  async download(@Param('token') token: string, @Res() res: Response) {
    if (!(this.storage instanceof LocalStorageDriver)) throw AppError.notFound('File');
    const parsed = this.storage.verifyToken(token);
    if (!parsed) throw AppError.forbidden('Download link is invalid or has expired', 'INVALID_DOWNLOAD_TOKEN');
    const { body, mime } = await this.files.readByKey(parsed.key);
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (parsed.name) res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(parsed.name)}"`);
    res.send(body);
  }
}

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    FilesService,
    {
      provide: STORAGE_DRIVER,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig): StorageDriver =>
        cfg.storage.driver === 's3'
          ? new S3StorageDriver(cfg.storage.s3)
          : new LocalStorageDriver(cfg.storage.localPath, cfg.storage.signingSecret, cfg.publicBaseUrl),
    },
  ],
  exports: [FilesService, STORAGE_DRIVER],
})
export class FilesModule {}
