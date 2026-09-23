import { Module } from '@nestjs/common';

import { ChannelsModule } from '../channels/channels.module';
import { MediaModule } from '../media/media.module';
import { EmailModule } from '../email/email.module';
import { CrmEmailController } from './crm-email.controller';
import { CrmEmailService } from './crm-email.service';
import { CrmIntegrationAuthGuard } from './crm-integration-auth.guard';
import { CrmIntegrationController } from './crm-integration.controller';
import { CrmContactSyncService } from './crm-contact-sync.service';
import { CrmOutboundService } from './crm-outbound.service';
import { CrmTelegramV3Service } from './crm-telegram-v3.service';
import { CrmWhatsAppV4Service } from './crm-whatsapp-v4.service';

@Module({
  controllers: [CrmIntegrationController, CrmEmailController],
  imports: [ChannelsModule, MediaModule, EmailModule],
  providers: [
    CrmEmailService,
    CrmIntegrationAuthGuard,
    CrmContactSyncService,
    CrmOutboundService,
    CrmTelegramV3Service,
    CrmWhatsAppV4Service,
  ],
  exports: [CrmOutboundService, CrmTelegramV3Service, CrmWhatsAppV4Service],
})
export class CrmIntegrationModule {}
