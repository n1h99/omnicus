import { HttpException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { urlencoded, type NextFunction, type Request, type Response } from 'express';

export function configureRequestBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', {
    limit: '2mb',
    verify: (request: Request, _response: unknown, buffer: Buffer) => {
      (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  });
  const formOptions = { extended: true, limit: '64kb', parameterLimit: 100, depth: 2 };
  const webhookForm = urlencoded(formOptions);
  app.use('/webhooks/webinar-stars', (request: Request, response: Response, next: NextFunction) => {
    webhookForm(request, response, (error?: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 400 || error.status === 413)
      ) {
        next(new HttpException('Invalid webhook form body', error.status));
        return;
      }
      next(error);
    });
  });
}
