import { Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { EmailService } from './email.service';

@Controller('api/v1/public/email')
export class EmailPublicController {
  constructor(@Inject(EmailService) private readonly email: EmailService) {}

  @Get('unsubscribe/:token')
  async view(@Param('token') token: string, @Res() response: Response) {
    const result = await this.email.unsubscribeView(token);
    response.status(200).type('html').send(result.html);
  }

  @Post('unsubscribe/:token')
  async unsubscribe(@Param('token') token: string, @Res() response: Response) {
    const result = await this.email.unsubscribe(token);
    response.status(200).type('html').send(result.html);
  }
}
