import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AccessModule } from '../access/access.module';
import { CrmIntegrationModule } from '../crm-integration/crm-integration.module';
import { MediaModule } from '../media/media.module';
import { CommunicationsController } from './communications.controller';
import { CommunicationsService } from './communications.service';

@Module({
  controllers: [CommunicationsController],
  imports: [AccessModule, CrmIntegrationModule, MediaModule, JwtModule.register({})],
  providers: [CommunicationsService],
})
export class CommunicationsModule {}
