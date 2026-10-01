import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { MetaLeadsController, MetaLeadsWebhookController } from './meta-leads.controller';
import { MetaLeadsService } from './meta-leads.service';
import { MetaLeadsRuntimeService } from './meta-leads-runtime.service';

@Module({
  imports: [AccessModule, AuthModule, AuditModule, JwtModule.register({})],
  controllers: [MetaLeadsController, MetaLeadsWebhookController],
  providers: [MetaLeadsService, MetaLeadsRuntimeService],
})
export class MetaLeadsModule {}
