import 'reflect-metadata';

import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import { parseCorsOrigins, parseTrustProxy, type ApiEnvironment } from '@omnicus/config/server';

import { AppModule } from './app.module';
import { configureApiApplication } from './platform/configure-api-application';

const logger = new ConsoleLogger({
  json: true,
  prefix: 'api',
});

function logFatalBootstrapError(error: unknown): void {
  logger.error({
    error:
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : { value: String(error) },
    message: 'Fatal API bootstrap failure',
    service: 'api',
  });
}

async function bootstrap(): Promise<void> {
  let app: NestExpressApplication | undefined;

  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false,
      logger,
    });
    app.useBodyParser('json', {
      limit: '2mb',
      verify: (request: Request, _response: unknown, buffer: Buffer) => {
        (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    });
    const config = app.get(ConfigService<ApiEnvironment, true>);
    const swaggerEnabled = config.get('SWAGGER_ENABLED', { infer: true });

    configureApiApplication(app, { swaggerEnabled });
    app.set('trust proxy', parseTrustProxy(config.get('TRUST_PROXY', { infer: true })));
    app.enableCors({
      credentials: true,
      exposedHeaders: ['Content-Disposition'],
      origin: parseCorsOrigins(config.get('CORS_ALLOWED_ORIGINS', { infer: true })),
    });
    app.enableShutdownHooks();

    if (swaggerEnabled) {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('Omnicus API')
        .setDescription('Stage 1 Auth, RBAC, Users, and Projects API')
        .setVersion('0.1.0')
        .build();
      SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
    }

    const port =
      config.get('PORT', { infer: true }) ?? config.get('API_PORT', { infer: true }) ?? 3000;
    const host = config.get('API_HOST', { infer: true });
    await app.listen(port, host);
    logger.log({
      host,
      message: 'API started',
      port,
      service: 'api',
    });
  } catch (error) {
    logFatalBootstrapError(error);
    if (app) {
      try {
        await app.close();
      } catch (closeError) {
        logger.error({
          error:
            closeError instanceof Error
              ? {
                  message: closeError.message,
                  name: closeError.name,
                  stack: closeError.stack,
                }
              : { value: String(closeError) },
          message: 'API cleanup after bootstrap failure failed',
          service: 'api',
        });
      }
    }
    process.exitCode = 1;
  }
}

void bootstrap();
