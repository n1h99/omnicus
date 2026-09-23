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
} from '@nestjs/common';
import {
  CrmIntegrationAuthGuard,
  type AuthenticatedCrmIntegrationRequest,
} from './crm-integration-auth.guard';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Runtime DTO metadata is required for request validation.
import { CrmEmailScopeDto, CrmSendEmailDto } from './crm-email.dto';
import { CrmEmailService } from './crm-email.service';

@UseGuards(CrmIntegrationAuthGuard)
@Controller('integrations/v1/crm/email')
export class CrmEmailController {
  constructor(@Inject(CrmEmailService) private readonly email: CrmEmailService) {}

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
}
