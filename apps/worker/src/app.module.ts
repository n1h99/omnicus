import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { rootEnvironmentFilePath, validateWorkerEnvironment } from '@omnicus/config/server';

import { DemoQueueModule } from './queue/demo-queue.module';
import { AutomationModule } from './automation/automation.module';
import { CrmModule } from './crm/crm.module';
import { DatabaseModule } from './database/database.module';
import { EmailDeliveryModule } from './email/email-delivery.module';
import { TelegramInboundModule } from './telegram-inbound/telegram-inbound.module';
import { TelegramOutboundModule } from './telegram-outbound/telegram-outbound.module';
import { WorkerHealthController } from './worker-health.controller';
import { BroadcastsModule } from './broadcasts/broadcasts.module';
import { MediaModule } from './media/media.module';
import { ExternalHttpModule } from './external-http/external-http.module';
import { WhatsAppInboundModule } from './whatsapp-inbound/whatsapp-inbound.module';
import { WhatsAppOutboundModule } from './whatsapp-outbound/whatsapp-outbound.module';

const rootEnvFile =
  process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging'
    ? undefined
    : rootEnvironmentFilePath();

@Module({
  controllers: [WorkerHealthController],
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: rootEnvFile ? [rootEnvFile] : [],
      isGlobal: true,
      validate: validateWorkerEnvironment,
    }),
    DatabaseModule,
    EmailDeliveryModule,
    AutomationModule,
    CrmModule,
    DemoQueueModule,
    TelegramInboundModule,
    TelegramOutboundModule,
    BroadcastsModule,
    MediaModule,
    ExternalHttpModule,
    WhatsAppInboundModule,
    WhatsAppOutboundModule,
  ],
})
export class AppModule {}
