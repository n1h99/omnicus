import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import {
  ApproveMetaLeadDto,
  MetaLeadHistoryDto,
  SaveMetaLeadConfigDto,
  StartMetaLeadsDto,
} from './meta-leads.dto';
import { MetaLeadsService } from './meta-leads.service';
import { IsBoolean } from 'class-validator';
import { ApiBody } from '@nestjs/swagger';

class RetryMetaLeadDto {
  @IsBoolean() confirmUnknownRetry = false;
}

@Controller('api/v1/projects/:projectId/meta-leads')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireProjectPermission('integrations:manage')
export class MetaLeadsController {
  constructor(
    @Inject(MetaLeadsService) private readonly leads: MetaLeadsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get() async config(@Param('projectId') projectId: string) {
    return { data: await this.leads.safeConfig(projectId), meta: {} };
  }

  @ApiBody({ type: SaveMetaLeadConfigDto })
  @Put()
  async save(
    @Param('projectId') projectId: string,
    @Body() body: SaveMetaLeadConfigDto,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'meta-leads.config.save', request);
    return { data: await this.leads.save(projectId, body), meta: {} };
  }
  @Post('test') async test(@Param('projectId') projectId: string) {
    return { data: await this.leads.test(projectId), meta: {} };
  }
  @ApiBody({ type: StartMetaLeadsDto })
  @Post('start')
  async start(
    @Param('projectId') projectId: string,
    @Body() body: StartMetaLeadsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.log(
      projectId,
      body.deliveryEnabled ? 'meta-leads.live.start' : 'meta-leads.preview.start',
      request,
    );
    return { data: await this.leads.start(projectId, body), meta: {} };
  }
  @Post('stop') async stop(
    @Param('projectId') projectId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'meta-leads.stop', request);
    return { data: await this.leads.stop(projectId), meta: {} };
  }
  @ApiBody({ type: MetaLeadHistoryDto })
  @Post('history-preview')
  async history(
    @Param('projectId') projectId: string,
    @Body() body: MetaLeadHistoryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'meta-leads.history.preview', request);
    return { data: await this.leads.history(projectId, body), meta: {} };
  }
  @Get('submissions') async submissions(
    @Param('projectId') projectId: string,
    @Query('cursor') cursor?: string,
  ) {
    const rows = await this.leads.database.client.metaLeadSubmission.findMany({
      where: { projectId, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: 100,
      select: {
        id: true,
        leadId: true,
        formId: true,
        state: true,
        historical: true,
        result: true,
        payload: true,
        lastError: true,
        attempts: true,
        createdAt: true,
      },
    });
    return {
      data: { items: rows, nextCursor: rows.length === 100 ? rows.at(-1)!.id : null },
      meta: {},
    };
  }
  @Get('polls') async polls(@Param('projectId') projectId: string) {
    const rows = await this.leads.database.client.metaLeadPoll.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        formId: true,
        historical: true,
        from: true,
        until: true,
        completed: true,
        lastError: true,
        nextAttemptAt: true,
      },
    });
    return { data: rows, meta: {} };
  }
  @ApiBody({ type: ApproveMetaLeadDto })
  @Post('submissions/:id/approve')
  async approve(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: ApproveMetaLeadDto,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'meta-leads.submission.approve', request, id);
    return {
      data: await this.leads.approve(projectId, id, body.confirmHistoricalImport),
      meta: {},
    };
  }
  @Post('submissions/:id/retry') async retry(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: RetryMetaLeadDto,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'meta-leads.submission.retry', request, id);
    return { data: await this.leads.retry(projectId, id, body.confirmUnknownRetry), meta: {} };
  }
  private log(projectId: string, action: string, request: AuthenticatedRequest, id?: string) {
    return this.audit.record({
      action,
      projectId,
      entityId: id ?? projectId,
      entityType: 'MetaLeadIntegration',
      actorUserId: request.auth?.userId,
      correlationId: firstHeaderValue(request.headers['x-correlation-id']) ?? 'unavailable',
    });
  }
}

@Controller('webhooks/meta-leads/:projectId')
export class MetaLeadsWebhookController {
  constructor(@Inject(MetaLeadsService) private readonly leads: MetaLeadsService) {}
  @Get() verify(
    @Param('projectId') projectId: string,
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    return this.leads.verify(projectId, mode, token, challenge);
  }
  @Post()
  @HttpCode(200)
  receive(
    @Param('projectId') projectId: string,
    @Req() request: AuthenticatedRequest & { rawBody?: Buffer },
    @Body() body: unknown,
  ) {
    return this.leads.receive(
      projectId,
      request.rawBody,
      firstHeaderValue(request.headers['x-hub-signature-256']),
      body,
    );
  }
}
