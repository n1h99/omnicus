import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AccessModule } from '../access/access.module';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { EmailController } from './email.controller';
import { EmailPublicController } from './email-public.controller';
import { EmailWebhooksController } from './email-webhooks.controller';
import { EmailWebhooksService } from './email-webhooks.service';
import { EmailService } from './email.service';

@Module({
  controllers: [EmailController, EmailPublicController, EmailWebhooksController],
  exports: [EmailService],
  imports: [AccessModule, AuditModule, DatabaseModule, JwtModule.register({})],
  providers: [EmailService, EmailWebhooksService],
})
export class EmailModule {}
