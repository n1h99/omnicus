import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TelegramWorkspaceService } from './telegram-workspace.service';
import { TelegramWorkspaceWriteDto } from './telegram-workspace.dto';

@ApiTags('communications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId/communications/contacts/:contactId/telegram/:identityId')
export class TelegramWorkspaceController {
  constructor(
    @Inject(TelegramWorkspaceService) private readonly workspace: TelegramWorkspaceService,
  ) {}

  @Get()
  @RequireProjectPermission('communications:read')
  async read(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Param('identityId') identityId: string,
    @Query('resource') resource: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.workspace.read(
        projectId,
        contactId,
        identityId,
        resource ?? '',
        request.auth!,
        this.context(request),
      ),
      meta: {},
    };
  }

  @Post()
  @RequireProjectPermission('communications:send')
  async write(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Param('identityId') identityId: string,
    @Body() input: TelegramWorkspaceWriteDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.workspace.write(
        projectId,
        contactId,
        identityId,
        input,
        request.auth!,
        this.context(request),
      ),
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
