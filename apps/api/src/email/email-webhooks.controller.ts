import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { EmailWebhooksService } from './email-webhooks.service';

@Controller('webhooks/resend')
export class EmailWebhooksController {
  constructor(@Inject(EmailWebhooksService) private readonly webhooks: EmailWebhooksService) {}

  @Post()
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') id?: string,
    @Headers('svix-signature') signature?: string,
    @Headers('svix-timestamp') timestamp?: string,
  ) {
    if (!request.rawBody || !id || !signature || !timestamp)
      throw new BadRequestException('resend_webhook_headers_missing');
    return this.webhooks.receive(request.rawBody, { id, signature, timestamp });
  }
}
