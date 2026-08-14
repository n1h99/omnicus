import { Controller, Get, Head, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { TrackingService } from './tracking.service';

@Controller('r')
export class TrackingController {
  constructor(@Inject(TrackingService) private readonly tracking: TrackingService) {}

  @Head(':token')
  async inspect(@Param('token') token: string, @Res() response: Response) {
    response.redirect(302, await this.tracking.target(token));
  }

  @Get(':token')
  async redirect(
    @Param('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const target = await this.tracking.click(token, {
      ...(request.ip ? { ip: request.ip } : {}),
      ...(request.get('referer') ? { referrer: request.get('referer')! } : {}),
      ...(request.get('user-agent') ? { userAgent: request.get('user-agent')! } : {}),
    });
    response.redirect(302, target);
  }
}
