import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequireProjectPermission } from '../access/access.decorators';
import { PermissionGuard } from '../access/permission.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Nest request validation requires DTO runtime metadata.
import {
  ConnectEmailDomainDto,
  CreateEmailMailboxDto,
  SaveEmailDraftDto,
  SendInboxEmailDto,
  UpdateEmailMailboxDto,
  UpdateEmailThreadStateDto,
} from './dto';
import { EmailInboxService } from './email-inbox.service';

const response = <T>(data: T) => ({ data, meta: {} });

@ApiTags('email-inbox')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/projects/:projectId/email-inbox')
export class EmailInboxController {
  constructor(@Inject(EmailInboxService) private readonly inbox: EmailInboxService) {}

  @Get('mailboxes')
  @RequireProjectPermission('email:read')
  async mailboxes(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
    return response(await this.inbox.mailboxes(projectId, request.auth!));
  }
  @Get('members')
  @RequireProjectPermission('email:manage')
  async members(@Param('projectId') projectId: string) {
    return response(await this.inbox.members(projectId));
  }
  @Get('health')
  @RequireProjectPermission('email:manage')
  async health(@Param('projectId') projectId: string) {
    return response(await this.inbox.health(projectId));
  }
  @Post('receipts/:receiptId/retry')
  @RequireProjectPermission('email:manage')
  async retryReceipt(
    @Param('projectId') projectId: string,
    @Param('receiptId') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.retryReceipt(projectId, id, request.auth!));
  }
  @Post('messages/:messageId/retry-automation')
  @RequireProjectPermission('email:manage')
  async retryAutomation(
    @Param('projectId') projectId: string,
    @Param('messageId') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.retryAutomation(projectId, id, request.auth!));
  }

  @Post('mailboxes')
  @RequireProjectPermission('email:manage')
  async createMailbox(
    @Param('projectId') projectId: string,
    @Body() input: CreateEmailMailboxDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.createMailbox(projectId, input, request.auth!));
  }
  @Patch('mailboxes/:mailboxId')
  @RequireProjectPermission('email:manage')
  async updateMailbox(
    @Param('projectId') projectId: string,
    @Param('mailboxId') id: string,
    @Body() input: UpdateEmailMailboxDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.updateMailbox(projectId, id, input, request.auth!));
  }
  @Get('domains')
  @RequireProjectPermission('email:manage')
  async domains(@Param('projectId') projectId: string) {
    return response(await this.inbox.domains(projectId));
  }

  @Get('available-domains')
  @RequireProjectPermission('email:manage')
  async availableDomains(
    @Param('projectId') projectId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.availableDomains(projectId, request.auth!));
  }
  @Post('domains')
  @RequireProjectPermission('email:manage')
  async connectDomain(
    @Param('projectId') projectId: string,
    @Body() input: ConnectEmailDomainDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(
      await this.inbox.connectDomain(projectId, input.providerDomainId, request.auth!),
    );
  }
  @Post('domains/:domainId/refresh')
  @RequireProjectPermission('email:manage')
  async refreshDomain(@Param('projectId') projectId: string, @Param('domainId') id: string) {
    return response(await this.inbox.refreshDomain(projectId, id));
  }
  @Get('threads')
  @RequireProjectPermission('email:read')
  async threads(
    @Param('projectId') projectId: string,
    @Req() request: AuthenticatedRequest,
    @Query('mailboxId') mailboxId?: string,
    @Query('folder') folder?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('contactId') contactId?: string,
  ) {
    return response(
      await this.inbox.threads(projectId, request.auth!, { mailboxId, folder, q, page, contactId }),
    );
  }

  @Get('threads/:threadId')
  @RequireProjectPermission('email:read')
  async thread(
    @Param('projectId') projectId: string,
    @Param('threadId') id: string,
    @Req() request: AuthenticatedRequest,
    @Query('before') before?: string,
  ) {
    return response(await this.inbox.thread(projectId, id, request.auth!, before));
  }
  @Patch('threads/:threadId/state')
  @RequireProjectPermission('email:read')
  async state(
    @Param('projectId') projectId: string,
    @Param('threadId') id: string,
    @Body() input: UpdateEmailThreadStateDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.threadState(projectId, id, input, request.auth!));
  }
  @Post('messages')
  @RequireProjectPermission('email:send')
  async send(
    @Param('projectId') projectId: string,
    @Body() input: SendInboxEmailDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.send(projectId, input, request.auth!));
  }
  @Get('drafts')
  @RequireProjectPermission('email:read')
  async drafts(@Param('projectId') projectId: string, @Req() request: AuthenticatedRequest) {
    return response(await this.inbox.drafts(projectId, request.auth!));
  }
  @Put('drafts/:draftId')
  @RequireProjectPermission('email:send')
  async saveDraft(
    @Param('projectId') projectId: string,
    @Param('draftId') id: string,
    @Body() input: SaveEmailDraftDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.saveDraft(projectId, id, input, request.auth!));
  }
  @Delete('drafts/:draftId')
  @RequireProjectPermission('email:send')
  async deleteDraft(
    @Param('projectId') projectId: string,
    @Param('draftId') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return response(await this.inbox.deleteDraft(projectId, id, request.auth!));
  }
  @Get('attachments/:attachmentId')
  @RequireProjectPermission('email:read')
  async attachment(
    @Param('projectId') projectId: string,
    @Param('attachmentId') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const file = await this.inbox.attachment(projectId, id, request.auth!);
    return new StreamableFile(file.bytes, {
      type: 'application/octet-stream',
      disposition: "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
      length: file.bytes.length,
    });
  }
  @Get('messages/:messageId/assets/:assetId')
  @RequireProjectPermission('email:read')
  async outgoingAttachment(
    @Param('projectId') projectId: string,
    @Param('messageId') messageId: string,
    @Param('assetId') assetId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const file = await this.inbox.outgoingAttachment(projectId, messageId, assetId, request.auth!);
    return new StreamableFile(file.bytes, {
      type: 'application/octet-stream',
      disposition: "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
      length: file.bytes.length,
    });
  }
}
