import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CrmIntegrationAuthGuard,
  type AuthenticatedCrmIntegrationRequest,
} from './crm-integration-auth.guard';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Runtime DTO metadata is required for request validation.
import {
  CrmEmailScopeDto,
  CrmSendEmailDto,
  CrmEmailUploadDto,
  CrmEmailReadDto,
  CrmEmailUnreadSummaryDto,
} from './crm-email.dto';
import { CrmEmailService } from './crm-email.service';

@UseGuards(CrmIntegrationAuthGuard)
@Controller('integrations/v1/crm/email')
export class CrmEmailController {
  constructor(@Inject(CrmEmailService) private readonly email: CrmEmailService) {}

  @Post('unread-summary')
  @HttpCode(200)
  unreadSummary(
    @Body() input: CrmEmailUnreadSummaryDto,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.email.unreadSummary(input, request.crmIntegration?.projectId);
  }

  @Post('threads/:threadId/read')
  @HttpCode(200)
  markRead(
    @Body() input: CrmEmailReadDto,
    @Param('threadId', new ParseUUIDPipe()) threadId: string,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.email.markRead(input, threadId, request.crmIntegration?.projectId);
  }

  @Get('context')
  context(@Query() input: CrmEmailScopeDto, @Req() request: AuthenticatedCrmIntegrationRequest) {
    return this.email.context(input, request.crmIntegration?.projectId);
  }

  @Get('threads')
  threads(@Query() input: CrmEmailScopeDto, @Req() request: AuthenticatedCrmIntegrationRequest) {
    return this.email.threads(input, request.crmIntegration?.projectId);
  }

  @Get('threads/:threadId')
  thread(
    @Query() input: CrmEmailScopeDto,
    @Param('threadId', new ParseUUIDPipe()) threadId: string,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.email.thread(input, threadId, request.crmIntegration?.projectId);
  }

  @Post('messages')
  @HttpCode(200)
  send(@Body() input: CrmSendEmailDto, @Req() request: AuthenticatedCrmIntegrationRequest) {
    return this.email.send(input, request.crmIntegration?.projectId);
  }

  @Post('attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 6 } }),
  )
  upload(
    @Body() input: CrmEmailUploadDto,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.email.upload(input, file, request.crmIntegration?.projectId);
  }

  @Get('attachments/:attachmentId')
  async attachment(
    @Query() input: CrmEmailScopeDto,
    @Param('attachmentId', new ParseUUIDPipe()) id: string,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.file(await this.email.attachment(input, id, request.crmIntegration?.projectId));
  }

  @Get('messages/:messageId/assets/:assetId')
  async outgoingAttachment(
    @Query() input: CrmEmailScopeDto,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Req() request: AuthenticatedCrmIntegrationRequest,
  ) {
    return this.file(
      await this.email.outgoingAttachment(
        input,
        messageId,
        assetId,
        request.crmIntegration?.projectId,
      ),
    );
  }

  private file(file: { bytes: Buffer; filename: string }) {
    return new StreamableFile(file.bytes, {
      type: 'application/octet-stream',
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    });
  }
}
