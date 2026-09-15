import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailInboundService } from './email-inbound.service';
import { AutomationModule } from '../automation/automation.module';

@Module({
  imports: [DatabaseModule, AutomationModule],
  providers: [EmailDeliveryService, EmailInboundService],
})
export class EmailDeliveryModule {}
