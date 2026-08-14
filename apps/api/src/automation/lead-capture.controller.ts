import { Body, Controller, Get, Headers, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';

import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CaptureLeadDto } from './lead-capture.dto';
import { LeadCaptureService } from './lead-capture.service';

@ApiTags('automation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId/lead-capture')
export class LeadCaptureConfigurationController {
  constructor(@Inject(LeadCaptureService) private readonly leadCapture: LeadCaptureService) {}

  @Get(':sourceKey')
  @RequireProjectPermission('automation:read')
  async configuration(
    @Param('projectId') projectId: string,
    @Param('sourceKey') sourceKey: string,
  ) {
    return { data: await this.leadCapture.configuration(projectId, sourceKey), meta: {} };
  }
}

@ApiTags('public-lead-capture')
@Controller('api/v1/public/projects/:projectId/leads')
export class PublicLeadCaptureController {
  constructor(@Inject(LeadCaptureService) private readonly leadCapture: LeadCaptureService) {}

  @Post(':sourceKey')
  @ApiBody({ type: CaptureLeadDto })
  async capture(
    @Param('projectId') projectId: string,
    @Param('sourceKey') sourceKey: string,
    @Headers('x-omnicus-ingest-key') secret: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CaptureLeadDto,
  ) {
    return {
      data: await this.leadCapture.capture(projectId, sourceKey, secret, idempotencyKey, body),
      meta: {},
    };
  }
}
