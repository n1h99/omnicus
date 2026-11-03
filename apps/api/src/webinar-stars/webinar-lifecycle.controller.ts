import {
  Body,
  Controller,
  Get,
  ForbiddenException,
  NotFoundException,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { WebinarLifecycleService } from './webinar-lifecycle.service';
import { LeadCaptureService } from '../automation/lead-capture.service';
import { AccessService } from '../access/access.service';
import { CreateContactDto } from '../contacts/dto';
import {
  WebinarEnableDto,
  WebinarEventDto,
  WebinarImportDto,
  WebinarInviteDto,
  WebinarMatchDto,
} from './webinar-lifecycle.dto';

@Controller('api/v1/projects/:projectId/webinar-stars')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireProjectPermission('integrations:manage')
export class WebinarLifecycleController {
  constructor(
    @Inject(WebinarLifecycleService) private readonly lifecycle: WebinarLifecycleService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LeadCaptureService) private readonly capture: LeadCaptureService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}
  @Get('events/:id/registration-config')
  @Header('Cache-Control', 'no-store')
  async registration(@Param('projectId') projectId: string, @Param('id') id: string) {
    const event = await this.lifecycle.database.client.webinarEvent.findFirst({
      where: { id, projectId, cancelledAt: null },
    });
    if (!event) throw new NotFoundException();
    const config = event.settings as Record<string, unknown>;
    if (typeof config.registrationSourceKey !== 'string')
      return { data: { configured: false }, meta: {} };
    const registration = await this.capture.configuration(projectId, config.registrationSourceKey);
    return {
      data: {
        configured: true,
        ...registration,
        bodyExample: { ...registration.bodyExample, metadata: { webinarEventId: id } },
      },
      meta: {},
    };
  }
  @Post('participants/:id/contact')
  @ApiBody({ type: CreateContactDto })
  async createContact(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: CreateContactDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (
      !req.auth ||
      !(await this.access.hasProjectPermission(req.auth.userId, projectId, 'contacts:create'))
    )
      throw new ForbiddenException();
    await this.log(projectId, 'webinar.contact.create', req, id);
    return { data: await this.lifecycle.createParticipantContact(projectId, id, body), meta: {} };
  }
  @Put('processing')
  @ApiBody({ type: WebinarEnableDto })
  async enable(
    @Param('projectId') projectId: string,
    @Body() body: WebinarEnableDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.processing.change', req);
    return { data: await this.lifecycle.enable(projectId, body.enabled), meta: {} };
  }
  @Post('webhook/rotate') async rotate(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.webhook.rotate', req);
    return { data: await this.lifecycle.rotateWebhook(projectId), meta: {} };
  }
  @Get('events') @Header('Cache-Control', 'no-store') async events(
    @Param('projectId') projectId: string,
  ) {
    return { data: await this.lifecycle.events(projectId), meta: {} };
  }
  @Post('events') @ApiBody({ type: WebinarEventDto }) async create(
    @Param('projectId') projectId: string,
    @Body() body: WebinarEventDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.event.create', req);
    return { data: await this.lifecycle.createEvent(projectId, body), meta: {} };
  }
  @Post('events/:id/cancel') async cancel(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.event.cancel', req, id);
    return { data: await this.lifecycle.cancelEvent(projectId, id), meta: {} };
  }
  @Post('events/:id/invitations') @ApiBody({ type: WebinarInviteDto }) async invite(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: WebinarInviteDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.invitation.create', req, id);
    return { data: await this.lifecycle.invite(projectId, id, body), meta: {} };
  }
  @Get('events/:id/invitations') @Header('Cache-Control', 'no-store') async invitations(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return { data: await this.lifecycle.invitations(projectId, id), meta: {} };
  }
  @Post('imports') @ApiBody({ type: WebinarImportDto }) async import(
    @Param('projectId') projectId: string,
    @Body() body: WebinarImportDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.report.import', req, body.reportId);
    return { data: await this.lifecycle.importReport(projectId, body), meta: {} };
  }
  @Get('imports') @Header('Cache-Control', 'no-store') async imports(
    @Param('projectId') projectId: string,
  ) {
    return { data: await this.lifecycle.imports(projectId), meta: {} };
  }
  @Post('imports/:id/retry') async retry(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.report.retry', req, id);
    return { data: await this.lifecycle.retry(projectId, id), meta: {} };
  }
  @Get('participants') @Header('Cache-Control', 'no-store') async participants(
    @Param('projectId') projectId: string,
    @Query('importId') id?: string,
  ) {
    return { data: await this.lifecycle.attendances(projectId, id), meta: {} };
  }
  @Post('participants/:id/match') @ApiBody({ type: WebinarMatchDto }) async match(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: WebinarMatchDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.participant.match', req, id);
    return { data: await this.lifecycle.match(projectId, id, body), meta: {} };
  }
  @Get('actions') @Header('Cache-Control', 'no-store') async actions(
    @Param('projectId') projectId: string,
  ) {
    return { data: await this.lifecycle.actions(projectId), meta: {} };
  }
  @Get('contact-options') @Header('Cache-Control', 'no-store') async contacts(
    @Param('projectId') projectId: string,
    @Query('search') search?: string,
  ) {
    return { data: await this.lifecycle.contactOptions(projectId, search), meta: {} };
  }
  @Put('events/:id/settings') async settings(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.settings.change', req, id);
    return { data: await this.lifecycle.updateSettings(projectId, id, body), meta: {} };
  }
  @Post('actions/:id/retry') async retryAction(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar.action.retry', req, id);
    return { data: await this.lifecycle.retryAction(projectId, id), meta: {} };
  }
  private log(projectId: string, action: string, req: AuthenticatedRequest, id?: string) {
    return this.audit.record({
      projectId,
      action,
      entityId: id ?? projectId,
      entityType: 'WebinarLifecycle',
      actorUserId: req.auth?.userId,
      correlationId: firstHeaderValue(req.headers['x-correlation-id']) ?? 'unavailable',
    });
  }
}
@Controller()
export class WebinarPublicController {
  constructor(
    @Inject(WebinarLifecycleService) private readonly lifecycle: WebinarLifecycleService,
  ) {}
  @Post('webhooks/webinar-stars/:projectId/:secret')
  @HttpCode(200)
  async receive(
    @Param('projectId') projectId: string,
    @Param('secret') secret: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle.receive(projectId, secret, body);
  }
  @Get('public/webinar-invitations/:token')
  @Header('Cache-Control', 'no-store')
  async redirect(@Param('token') token: string, @Res() res: Response) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, await this.lifecycle.redirect(token));
  }
}
