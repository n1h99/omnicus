import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation/automation.module';
import { ProjectCrmClient } from '../crm/project-crm.client';
import { WebinarActionsService } from './webinar-actions.service';
@Module({ imports: [AutomationModule], providers: [WebinarActionsService, ProjectCrmClient] })
export class WebinarsModule {}
