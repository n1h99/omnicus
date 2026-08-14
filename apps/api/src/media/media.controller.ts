import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { MediaKind } from '@omnicus/media-core';

import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import type { RequestSecurityContext } from '../auth/auth.service';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId/media-assets')
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Get()
  @RequireProjectPermission('media:read')
  async list(@Param('projectId') projectId: string) {
    return { data: await this.media.list(projectId), meta: {} };
  }

  @Get(':assetId')
  @RequireProjectPermission('media:read')
  async get(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return { data: await this.media.get(projectId, assetId), meta: {} };
  }

  @Post('upload/:kind')
  @RequireProjectPermission('media:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      properties: { file: { format: 'binary', type: 'string' } },
      required: ['file'],
      type: 'object',
    },
  })
  async upload(
    @Param('projectId') projectId: string,
    @Param('kind') kind: MediaKind,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
    @Req() request: AuthenticatedRequest,
    @Query('channel') channel?: string,
  ) {
    if (
      ![
        'ANIMATION',
        'AUDIO',
        'DOCUMENT',
        'PHOTO',
        'STICKER',
        'VIDEO',
        'VIDEO_NOTE',
        'VOICE',
      ].includes(kind)
    )
      throw new BadRequestException({
        code: 'MEDIA_KIND_INVALID',
        message: 'Media kind is invalid',
      });
    if (channel !== undefined && !['email', 'telegram', 'whatsapp'].includes(channel))
      throw new BadRequestException({
        code: 'MEDIA_CHANNEL_INVALID',
        message: 'Media channel is invalid',
      });
    return {
      data: await this.media.upload(
        projectId,
        kind,
        file,
        request.auth!,
        this.context(request),
        (channel ?? 'telegram') as 'email' | 'telegram' | 'whatsapp',
      ),
      meta: {},
    };
  }

  @Post(':assetId/materialize')
  @RequireProjectPermission('media:manage')
  async materialize(
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.media.materialize(projectId, assetId, request.auth!, this.context(request)),
      meta: {},
    };
  }

  @Get(':assetId/url')
  @RequireProjectPermission('media:read')
  async signedUrl(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return { data: await this.media.signedUrl(projectId, assetId), meta: {} };
  }

  @Delete(':assetId')
  @RequireProjectPermission('media:manage')
  async remove(
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.media.remove(projectId, assetId, request.auth!, this.context(request)),
      meta: {},
    };
  }

  private context(request: AuthenticatedRequest): RequestSecurityContext {
    return {
      correlationId: firstHeaderValue(request.headers['x-correlation-id']) ?? 'unavailable',
      ip: request.ip,
      userAgent: firstHeaderValue(request.headers['user-agent']),
    };
  }
}
