import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AccessModule } from '../access/access.module';
import { CrmIntegrationModule } from '../crm-integration/crm-integration.module';
import { MediaModule } from '../media/media.module';
import { CommunicationsController } from './communications.controller';
import { CommunicationsService } from './communications.service';
import { TelegramWorkspaceController } from './telegram-workspace.controller';
import { TelegramWorkspaceService } from './telegram-workspace.service';

@Module({
  controllers: [CommunicationsController, TelegramWorkspaceController],
  imports: [AccessModule, CrmIntegrationModule, MediaModule, JwtModule.register({})],
  providers: [CommunicationsService, TelegramWorkspaceService],
})
export class CommunicationsModule {}
