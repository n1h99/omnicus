import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { EmailDeliveryService } from './email-delivery.service';

@Module({
  imports: [DatabaseModule],
  providers: [EmailDeliveryService],
})
export class EmailDeliveryModule {}
