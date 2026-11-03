import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AutomationModule } from '../automation/automation.module';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { WebinarStarsController } from './webinar-stars.controller';
import { WebinarStarsService } from './webinar-stars.service';
import { WebinarLifecycleService } from './webinar-lifecycle.service';
import { WebinarImportRuntimeService } from './webinar-import-runtime.service';
import { WebinarReportingService } from './webinar-reporting.service';
import {
  WebinarLifecycleController,
  WebinarPublicController,
} from './webinar-lifecycle.controller';

@Module({
  imports: [AccessModule, AuthModule, AuditModule, AutomationModule, JwtModule.register({})],
  controllers: [WebinarStarsController, WebinarLifecycleController, WebinarPublicController],
  providers: [
    WebinarStarsService,
    WebinarLifecycleService,
    WebinarImportRuntimeService,
    WebinarReportingService,
  ],
})
export class WebinarStarsModule {}
