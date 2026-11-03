import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { ReportListDto, SaveWebinarConnectionDto, WebinarListDto } from './webinar-stars.dto';
import { WebinarStarsService } from './webinar-stars.service';

@Controller('api/v1/projects/:projectId/webinar-stars')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireProjectPermission('integrations:manage')
export class WebinarStarsController {
  constructor(
    @Inject(WebinarStarsService) private readonly service: WebinarStarsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  async config(@Param('projectId') projectId: string) {
    return { data: await this.service.config(projectId), meta: {} };
  }
  @Put()
  @ApiBody({ type: SaveWebinarConnectionDto })
  async save(
    @Param('projectId') projectId: string,
    @Body() body: SaveWebinarConnectionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar-stars.connection.save', req);
    return { data: await this.service.save(projectId, body), meta: {} };
  }
  @Delete() async disconnect(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar-stars.connection.disconnect', req);
    return { data: await this.service.disconnect(projectId), meta: {} };
  }
  @Post('test') async test(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.log(projectId, 'webinar-stars.connection.test', req);
    return { data: await this.service.test(projectId), meta: {} };
  }
  @Get('webinars')
  @Header('Cache-Control', 'no-store')
  @ApiQuery({ type: WebinarListDto })
  async webinars(@Param('projectId') projectId: string, @Query() query: WebinarListDto) {
    return { data: await this.service.webinars(projectId, query), meta: {} };
  }
  @Get('reports')
  @Header('Cache-Control', 'no-store')
  @ApiQuery({ type: ReportListDto })
  async reports(@Param('projectId') projectId: string, @Query() query: ReportListDto) {
    return { data: await this.service.reports(projectId, query), meta: {} };
  }
  @Get('reports/:reportId')
  @Header('Cache-Control', 'no-store')
  async report(@Param('projectId') projectId: string, @Param('reportId') reportId: string) {
    return { data: await this.service.report(projectId, reportId), meta: {} };
  }
  private log(projectId: string, action: string, req: AuthenticatedRequest) {
    return this.audit.record({
      projectId,
      action,
      entityId: projectId,
      entityType: 'WebinarConnection',
      actorUserId: req.auth?.userId,
      correlationId: firstHeaderValue(req.headers['x-correlation-id']) ?? 'unavailable',
    });
  }
}
