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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import type { RequestSecurityContext } from '../auth/auth.service';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Nest runtime validation needs DTO class metadata.
import {
  CreateEmailCampaignDto,
  CreateEmailSuppressionDto,
  CreateEmailTemplateDto,
  TestEmailDto,
  UpdateEmailCampaignDto,
  UpdateEmailTemplateDraftDto,
} from './dto';
import { EmailService } from './email.service';

@ApiTags('email')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId/email')
export class EmailController {
  constructor(@Inject(EmailService) private readonly email: EmailService) {}

  @Get('campaigns')
  @RequireProjectPermission('broadcasts:read')
  async campaigns(@Param('projectId') projectId: string) {
    return { data: await this.email.listCampaigns(projectId), meta: {} };
  }

  @Post('campaigns')
  @RequireProjectPermission('broadcasts:create')
  async createCampaign(
    @Param('projectId') projectId: string,
    @Body() input: CreateEmailCampaignDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.createCampaign(projectId, input, request.auth!, this.context(request)),
      meta: {},
    };
  }

  @Get('campaigns/:campaignId')
  @RequireProjectPermission('broadcasts:read')
  async campaign(@Param('projectId') projectId: string, @Param('campaignId') campaignId: string) {
    return { data: await this.email.getCampaign(projectId, campaignId), meta: {} };
  }

  @Patch('campaigns/:campaignId')
  @RequireProjectPermission('broadcasts:create')
  async updateCampaign(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @Body() input: UpdateEmailCampaignDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.updateCampaign(
        projectId,
        campaignId,
        input,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Delete('campaigns/:campaignId')
  @RequireProjectPermission('broadcasts:create')
  async deleteCampaign(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.deleteCampaign(
        projectId,
        campaignId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post('campaigns/:campaignId/estimate')
  @RequireProjectPermission('broadcasts:read')
  async estimate(@Param('projectId') projectId: string, @Param('campaignId') campaignId: string) {
    return { data: await this.email.estimateCampaign(projectId, campaignId), meta: {} };
  }

  @Post('campaigns/:campaignId/launch')
  @RequireProjectPermission('broadcasts:launch')
  async launch(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.launchCampaign(
        projectId,
        campaignId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post('campaigns/:campaignId/pause')
  @RequireProjectPermission('broadcasts:pause')
  async pause(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.pauseCampaign(
        projectId,
        campaignId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post('campaigns/:campaignId/resume')
  @RequireProjectPermission('broadcasts:pause')
  async resume(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.resumeCampaign(
        projectId,
        campaignId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post('campaigns/:campaignId/cancel')
  @RequireProjectPermission('broadcasts:cancel')
  async cancel(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.cancelCampaign(
        projectId,
        campaignId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post('campaigns/:campaignId/retry-failed')
  @RequireProjectPermission('broadcasts:launch')
  async retryFailed(
    @Param('projectId') projectId: string,
    @Param('campaignId') campaignId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.retryFailed(
        projectId,
        campaignId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Get('campaigns/:campaignId/deliveries')
  @RequireProjectPermission('broadcasts:read')
  async deliveries(@Param('projectId') projectId: string, @Param('campaignId') campaignId: string) {
    return { data: await this.email.listDeliveries(projectId, campaignId), meta: {} };
  }

  @Get('analytics/events')
  @RequireProjectPermission('broadcasts:read')
  async analytics(
    @Param('projectId') projectId: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '25',
  ) {
    return {
      data: await this.email.listAnalytics(projectId, page, pageSize),
      meta: {},
    };
  }

  @Get('deliveries/:deliveryId')
  @RequireProjectPermission('broadcasts:read')
  async delivery(@Param('projectId') projectId: string, @Param('deliveryId') deliveryId: string) {
    return { data: await this.email.getDelivery(projectId, deliveryId), meta: {} };
  }

  @Post('test-send')
  @RequireProjectPermission('broadcasts:create')
  async testSend(
    @Param('projectId') projectId: string,
    @Body() input: TestEmailDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.testSend(projectId, input, request.auth!, this.context(request)),
      meta: {},
    };
  }

  @Get('templates')
  @RequireProjectPermission('broadcasts:read')
  async templates(@Param('projectId') projectId: string) {
    return { data: await this.email.listTemplates(projectId), meta: {} };
  }

  @Post('templates')
  @RequireProjectPermission('broadcasts:create')
  async createTemplate(
    @Param('projectId') projectId: string,
    @Body() input: CreateEmailTemplateDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.createTemplate(projectId, input, request.auth!, this.context(request)),
      meta: {},
    };
  }

  @Patch('templates/:templateId/draft')
  @RequireProjectPermission('broadcasts:create')
  async updateTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @Body() input: UpdateEmailTemplateDraftDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.updateTemplateDraft(
        projectId,
        templateId,
        input,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post('templates/:templateId/publish')
  @RequireProjectPermission('broadcasts:launch')
  async publishTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.publishTemplate(
        projectId,
        templateId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post('templates/:templateId/duplicate')
  @RequireProjectPermission('broadcasts:create')
  async duplicateTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.duplicateTemplate(
        projectId,
        templateId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Delete('templates/:templateId')
  @RequireProjectPermission('broadcasts:create')
  async archiveTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.archiveTemplate(
        projectId,
        templateId,
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Get('audience-options')
  @RequireProjectPermission('broadcasts:read')
  async audienceOptions(@Param('projectId') projectId: string) {
    return { data: await this.email.audienceOptions(projectId), meta: {} };
  }

  @Get('suppressions')
  @RequireProjectPermission('broadcasts:read')
  async suppressions(@Param('projectId') projectId: string) {
    return { data: await this.email.listSuppressions(projectId), meta: {} };
  }

  @Post('suppressions')
  @RequireProjectPermission('broadcasts:create')
  async suppress(
    @Param('projectId') projectId: string,
    @Body() input: CreateEmailSuppressionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.addSuppression(projectId, input, request.auth!, this.context(request)),
      meta: {},
    };
  }

  @Delete('suppressions/:suppressionId')
  @RequireProjectPermission('broadcasts:create')
  async removeSuppression(
    @Param('projectId') projectId: string,
    @Param('suppressionId') suppressionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.email.removeSuppression(
        projectId,
        suppressionId,
        request.auth!,
        this.context(request),
      ),
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
