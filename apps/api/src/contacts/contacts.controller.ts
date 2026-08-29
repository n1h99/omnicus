import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { firstHeaderValue, type AuthenticatedRequest } from '../auth/auth.types';
import type { RequestSecurityContext } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CreateCustomFieldDto,
  CreateSegmentDto,
  CreateTagDto,
  ContactsQueryDto,
  MergeContactsDto,
  AddTagDto,
  BulkTagsDto,
  CreateContactDto,
  UpdateContactDto,
  UpdateCustomFieldDto,
  UpdateSegmentDto,
  UpdateTagDto,
} from './dto';
import { ContactsService } from './contacts.service';

@ApiTags('contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId')
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @Get('contacts')
  @RequireProjectPermission('contacts:read')
  @ApiQuery({ type: ContactsQueryDto })
  async list(@Param('projectId') projectId: string, @Query() query: ContactsQueryDto) {
    return { data: await this.contacts.list(projectId, query), meta: {} };
  }

  @Post('contacts')
  @RequireProjectPermission('contacts:manage')
  @ApiBody({ type: CreateContactDto })
  async create(
    @Param('projectId') projectId: string,
    @Body() body: CreateContactDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.create(projectId, body, this.context(request)),
      meta: {},
    };
  }

  @Get('contacts/:contactId')
  @RequireProjectPermission('contacts:read')
  async get(@Param('projectId') projectId: string, @Param('contactId') contactId: string) {
    return { data: await this.contacts.get(projectId, contactId), meta: {} };
  }

  @Patch('contacts/:contactId')
  @RequireProjectPermission('contacts:update')
  @ApiBody({ type: UpdateContactDto })
  async update(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Body() body: UpdateContactDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.update(projectId, contactId, body, this.context(request)),
      meta: {},
    };
  }

  @Get('contacts/:contactId/timeline')
  @RequireProjectPermission('contacts:read')
  async timeline(@Param('projectId') projectId: string, @Param('contactId') contactId: string) {
    return { data: await this.contacts.timeline(projectId, contactId), meta: {} };
  }

  @Post('contacts/merge')
  @RequireProjectPermission('contacts:merge')
  @ApiBody({ type: MergeContactsDto })
  async merge(
    @Param('projectId') projectId: string,
    @Body() body: MergeContactsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return { data: await this.contacts.merge(projectId, body, this.context(request)), meta: {} };
  }

  @Get('segments')
  @RequireProjectPermission('contacts:read')
  async listSegments(@Param('projectId') projectId: string) {
    return { data: await this.contacts.listSegments(projectId), meta: {} };
  }

  @Post('segments')
  @RequireProjectPermission('contacts:update')
  @ApiBody({ type: CreateSegmentDto })
  async createSegment(
    @Param('projectId') projectId: string,
    @Body() body: CreateSegmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.createSegment(projectId, body, this.context(request)),
      meta: {},
    };
  }

  @Patch('segments/:segmentId')
  @RequireProjectPermission('contacts:update')
  @ApiBody({ type: UpdateSegmentDto })
  async updateSegment(
    @Param('projectId') projectId: string,
    @Param('segmentId') segmentId: string,
    @Body() body: UpdateSegmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.updateSegment(projectId, segmentId, body, this.context(request)),
      meta: {},
    };
  }

  @Delete('segments/:segmentId')
  @HttpCode(204)
  @RequireProjectPermission('contacts:update')
  async archiveSegment(
    @Param('projectId') projectId: string,
    @Param('segmentId') segmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.contacts.archiveSegment(projectId, segmentId, this.context(request));
  }

  @Get('tags')
  @RequireProjectPermission('tags:read')
  async listTags(@Param('projectId') projectId: string) {
    return { data: await this.contacts.listTags(projectId), meta: {} };
  }

  @Post('tags')
  @RequireProjectPermission('tags:manage')
  @ApiBody({ type: CreateTagDto })
  async createTag(
    @Param('projectId') projectId: string,
    @Body() body: CreateTagDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.createTag(projectId, body, this.context(request)),
      meta: {},
    };
  }

  @Patch('tags/:tagId')
  @RequireProjectPermission('tags:manage')
  @ApiBody({ type: UpdateTagDto })
  async updateTag(
    @Param('projectId') projectId: string,
    @Param('tagId') tagId: string,
    @Body() body: UpdateTagDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.updateTag(projectId, tagId, body, this.context(request)),
      meta: {},
    };
  }

  @Delete('tags/:tagId')
  @HttpCode(204)
  @RequireProjectPermission('tags:manage')
  async deleteTag(
    @Param('projectId') projectId: string,
    @Param('tagId') tagId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.contacts.archiveTag(projectId, tagId, this.context(request));
  }

  @Post('contacts/:contactId/tags')
  @RequireProjectPermission('tags:manage')
  @HttpCode(204)
  @ApiBody({ type: AddTagDto })
  async addTag(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Body() body: AddTagDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.contacts.addTag(projectId, contactId, body, this.context(request));
  }

  @Delete('contacts/:contactId/tags/:tagId')
  @RequireProjectPermission('tags:manage')
  @HttpCode(204)
  async removeTag(
    @Param('projectId') projectId: string,
    @Param('contactId') contactId: string,
    @Param('tagId') tagId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.contacts.removeTag(projectId, contactId, tagId, this.context(request));
  }

  @Post('contacts/bulk-tags')
  @RequireProjectPermission('tags:manage')
  @HttpCode(204)
  @ApiBody({ type: BulkTagsDto })
  async bulkTags(
    @Param('projectId') projectId: string,
    @Body() body: BulkTagsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.contacts.bulkTags(projectId, body, this.context(request));
  }

  @Get('custom-fields')
  @RequireProjectPermission('contacts:read')
  async listCustomFields(
    @Param('projectId') projectId: string,
    @Query('archived') archived?: string,
  ) {
    return {
      data: await this.contacts.listCustomFields(projectId, archived === 'true'),
      meta: {},
    };
  }

  @Post('custom-fields')
  @RequireProjectPermission('contacts:update')
  @ApiBody({ type: CreateCustomFieldDto })
  async createCustomField(
    @Param('projectId') projectId: string,
    @Body() body: CreateCustomFieldDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.createCustomField(projectId, body, this.context(request)),
      meta: {},
    };
  }

  @Patch('custom-fields/:fieldId')
  @RequireProjectPermission('contacts:update')
  @ApiBody({ type: UpdateCustomFieldDto })
  async updateCustomField(
    @Param('projectId') projectId: string,
    @Param('fieldId') fieldId: string,
    @Body() body: UpdateCustomFieldDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.updateCustomField(projectId, fieldId, body, this.context(request)),
      meta: {},
    };
  }

  @Delete('custom-fields/:fieldId')
  @RequireProjectPermission('contacts:update')
  @HttpCode(204)
  async deleteCustomField(
    @Param('projectId') projectId: string,
    @Param('fieldId') fieldId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.contacts.archiveCustomField(projectId, fieldId, this.context(request));
  }

  @Post('custom-fields/:fieldId/restore')
  @RequireProjectPermission('contacts:update')
  async restoreCustomField(
    @Param('projectId') projectId: string,
    @Param('fieldId') fieldId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return {
      data: await this.contacts.restoreCustomField(projectId, fieldId, this.context(request)),
      meta: {},
    };
  }

  private context(
    request: AuthenticatedRequest,
  ): RequestSecurityContext & { actorUserId: string; actorEmail: string } {
    return {
      actorEmail: request.auth!.email,
      actorUserId: request.auth!.userId,
      correlationId: firstHeaderValue(request.headers['x-correlation-id']) ?? 'unavailable',
      ip: request.ip,
      userAgent: firstHeaderValue(request.headers['user-agent']),
    };
  }
}
