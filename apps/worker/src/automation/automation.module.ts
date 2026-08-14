import { Module } from '@nestjs/common';

import { AutomationRuntimeService } from './automation-runtime.service';
import { AutomationContinuationService } from './automation-continuation.service';
import { LeadCaptureProcessorService } from './lead-capture-processor.service';

@Module({
  exports: [AutomationRuntimeService, AutomationContinuationService],
  providers: [AutomationRuntimeService, AutomationContinuationService, LeadCaptureProcessorService],
})
export class AutomationModule {}
