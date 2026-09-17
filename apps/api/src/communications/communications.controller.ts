import {
  BadRequestException,
  Body,
  Controller,
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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { MediaKind } from '@omnicus/media-core';

import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import type { RequestSecurityContext } from '../auth/auth.service';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService } from '../media/media.service';
import { CommunicationsService } from './communications.service';
import {
  CommunicationMessagesQueryDto,
  CommunicationsContactsQueryDto,
  CommunicationTemplatesQueryDto,
  SendCommunicationMessageDto,
} from './dto';

const response = <T>(data: T) => ({ data, meta: {} });

@ApiTags('communications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId/communications')
export class CommunicationsController {
  constructor(
    @Inject(CommunicationsService) private readonly communications: CommunicationsService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  @Get('contacts')
  @RequireProjectPermission('communications:read')
  @ApiQuery({ type: CommunicationsContactsQueryDto })
  async contacts(
    @Param('projectId') projectId: string,
    @Query() query: CommunicationsContactsQueryDto,
  ) {
    return response(await this.communications.contacts(projectId, query));
  }

  @Get('contacts/:contactId')
  @RequireProjectPermission('communications:read')
  async contact(@Param('projectId') projectId: string, @Param('contactId') contactId: string) {
    return response(await this.communications.contact(projectId, contactId));
  }

  @Get('contacts/:contactId/messages')
  @RequireProjectPermission('communications:read')
  @ApiQuery({ type: CommunicationMessagesQueryDto })
  async messages(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Query() query: CommunicationMessagesQueryDto,
  ) {
    return response(await this.communications.messages(projectId, contactId, query));
  }

  @Get('contacts/:contactId/whatsapp-templates')
  @RequireProjectPermission('communications:read')
  @ApiQuery({ type: CommunicationTemplatesQueryDto })
  async templates(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Query() query: CommunicationTemplatesQueryDto,
  ) {
    return response(await this.communications.templates(projectId, contactId, query.connectionId));
  }

  @Post('contacts/:contactId/messages')
  @RequireProjectPermission('communications:send')
  @ApiBody({ type: SendCommunicationMessageDto })
  async send(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Body() input: SendCommunicationMessageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(
      await this.communications.send(
        projectId,
        contactId,
        input,
        request.auth!,
        this.context(request),
      ),
    );
  }

  @Get('media')
  @RequireProjectPermission('communications:send')
  async mediaAssets(@Param('projectId') projectId: string) {
    return response(await this.media.list(projectId));
  }

  @Post('media/upload/:kind')
  @RequireProjectPermission('communications:send')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      properties: { file: { format: 'binary', type: 'string' } },
      required: ['file'],
      type: 'object',
    },
  })
  async uploadMedia(
    @Param('projectId') projectId: string,
    @Param('kind') kind: MediaKind,
    @Query('channel') channel: string,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
    @Req() request: AuthenticatedRequest,
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
      throw new BadRequestException({ code: 'MEDIA_KIND_INVALID' });
    if (!['telegram', 'whatsapp'].includes(channel))
      throw new BadRequestException({ code: 'MEDIA_CHANNEL_INVALID' });
    return response(
      await this.media.upload(
        projectId,
        kind,
        file,
        request.auth!,
        this.context(request),
        channel as 'telegram' | 'whatsapp',
      ),
    );
  }

  @Get('media/:assetId/url')
  @RequireProjectPermission('communications:send')
  async mediaUrl(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return response(await this.media.signedUrl(projectId, assetId));
  }

  private context(request: AuthenticatedRequest): RequestSecurityContext {
    return {
      correlationId: firstHeaderValue(request.headers['x-correlation-id']) ?? 'unavailable',
      ip: request.ip,
      userAgent: firstHeaderValue(request.headers['user-agent']),
    };
  }
}
