import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import type { WhatsAppTemplateDraft } from '@omnicus/channel-whatsapp';
import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { WhatsAppChannelsService } from './whatsapp-channels.service';
import { WhatsAppManagementService } from './whatsapp-management.service';

export class SaveWhatsAppTemplateDto {
  @IsObject() template!: WhatsAppTemplateDraft;
}

@ApiTags('whatsapp-management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId/channels/:connectionId/whatsapp')
export class WhatsAppManagementController {
  constructor(
    @Inject(WhatsAppChannelsService) private readonly channels: WhatsAppChannelsService,
    @Inject(WhatsAppManagementService) private readonly management: WhatsAppManagementService,
  ) {}

  @Get('health')
  @RequireProjectPermission('channels:read')
  async health(@Param('projectId') projectId: string, @Param('connectionId') connectionId: string) {
    return { data: await this.management.health(projectId, connectionId), meta: {} };
  }
  @Get('billing')
  @RequireProjectPermission('channels:manage')
  async billing(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @Query('days') days?: string,
  ) {
    return {
      data: await this.management.billing(
        projectId,
        connectionId,
        ['7', '30', '90'].includes(days ?? '') ? Number(days) : 30,
      ),
      meta: {},
    };
  }
  @Post('templates')
  @RequireProjectPermission('channels:manage')
  async create(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @Body() dto: SaveWhatsAppTemplateDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.channels.saveTemplate(
        projectId,
        connectionId,
        dto.template,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }
  @Patch('templates/:templateId')
  @RequireProjectPermission('channels:manage')
  async edit(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @Param('templateId') templateId: string,
    @Body() dto: SaveWhatsAppTemplateDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.channels.saveTemplate(
        projectId,
        connectionId,
        dto.template,
        request.auth!,
        this.context(request),
        templateId,
      ),
      meta: {},
    };
  }
  @Delete('templates/:templateId')
  @RequireProjectPermission('channels:manage')
  async remove(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @Param('templateId') templateId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.channels.deleteTemplate(
        projectId,
        connectionId,
        templateId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }
  @Post('template-sample')
  @RequireProjectPermission('channels:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024, files: 1 } }))
  async sample(
    @Param('projectId') projectId: string,
    @Param('connectionId') connectionId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname: string } | undefined,
  ) {
    return {
      data: await this.channels.uploadTemplateSample(projectId, connectionId, file),
      meta: {},
    };
  }
  private context(request: AuthenticatedRequest) {
    return {
      correlationId: firstHeaderValue(request.headers['x-correlation-id']) ?? 'unavailable',
      ip: request.ip,
      userAgent: firstHeaderValue(request.headers['user-agent']),
    };
  }
}
