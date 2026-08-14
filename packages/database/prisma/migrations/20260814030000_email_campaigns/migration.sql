ALTER TYPE "CrmOperationType" ADD VALUE IF NOT EXISTS 'FORWARD_EMAIL_EVENT';

CREATE TYPE "EmailTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "EmailTemplateVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');
CREATE TYPE "EmailCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PREPARING', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED', 'ARCHIVED');
CREATE TYPE "EmailDeliverySource" AS ENUM ('CAMPAIGN', 'AUTOMATION', 'TEST');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'SENT', 'DELIVERED', 'DELIVERY_DELAYED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED', 'CANCELLED');
CREATE TYPE "EmailEventType" AS ENUM ('SENT', 'DELIVERED', 'DELIVERY_DELAYED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED', 'UNSUBSCRIBED');
CREATE TYPE "EmailSuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT', 'PROVIDER_SUPPRESSION', 'MANUAL');

ALTER TABLE "contacts"
  ADD COLUMN "emailConsentStatus" "MarketingConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "emailConsentSource" TEXT,
  ADD COLUMN "emailConsentAt" TIMESTAMPTZ(3),
  ADD COLUMN "emailOptOutAt" TIMESTAMPTZ(3);

UPDATE "contacts"
SET
  "emailConsentStatus" = CASE
    WHEN "customFields" #>> '{leadRegistration,consents,email}' = 'true'
      THEN 'GRANTED'::"MarketingConsentStatus"
    ELSE 'REVOKED'::"MarketingConsentStatus"
  END,
  "emailConsentSource" = 'legacy_website_registration',
  "emailConsentAt" = CASE
    WHEN "customFields" #>> '{leadRegistration,consents,email}' = 'true'
      THEN "updatedAt"
    ELSE NULL
  END,
  "emailOptOutAt" = CASE
    WHEN "customFields" #>> '{leadRegistration,consents,email}' = 'false'
      THEN "updatedAt"
    ELSE NULL
  END
WHERE "customFields" #>> '{leadRegistration,consents,email}' IN ('true', 'false');

CREATE TABLE "email_templates" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "EmailTemplateStatus" NOT NULL DEFAULT 'DRAFT',
  "activeVersionId" TEXT,
  "draftVersionId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_template_versions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "EmailTemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "subject" TEXT NOT NULL,
  "preheader" TEXT,
  "design" JSONB NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "email_template_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_campaigns" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "EmailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "subject" TEXT NOT NULL,
  "preheader" TEXT,
  "design" JSONB NOT NULL,
  "audience" JSONB NOT NULL,
  "sourceTemplateVersionId" TEXT,
  "scheduledAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "failedAt" TIMESTAMPTZ(3),
  "errorCode" TEXT,
  "preparationLockedAt" TIMESTAMPTZ(3),
  "preparationLockedBy" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "email_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_deliveries" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "campaignId" TEXT,
  "contactId" TEXT,
  "templateVersionId" TEXT,
  "scenarioExecutionId" TEXT,
  "nodeId" TEXT,
  "source" "EmailDeliverySource" NOT NULL,
  "toEmail" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "preheader" TEXT,
  "designSnapshot" JSONB NOT NULL,
  "attachmentAssetIds" JSONB NOT NULL DEFAULT '[]',
  "unsubscribeToken" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "providerEmailId" TEXT,
  "providerLastEventAt" TIMESTAMPTZ(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  "nextAttemptAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "queuedAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(3),
  "deliveredAt" TIMESTAMPTZ(3),
  "openedAt" TIMESTAMPTZ(3),
  "clickedAt" TIMESTAMPTZ(3),
  "bouncedAt" TIMESTAMPTZ(3),
  "complainedAt" TIMESTAMPTZ(3),
  "failedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_events" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "type" "EmailEventType" NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "targetUrl" TEXT,
  "providerPayload" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_suppressions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "reason" "EmailSuppressionReason" NOT NULL,
  "source" TEXT NOT NULL,
  "detail" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_asset_references" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "projectId" TEXT NOT NULL,
  "mediaAssetId" TEXT NOT NULL,
  "ownerType" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "usage" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_asset_references_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_templates_projectId_id_key" ON "email_templates"("projectId", "id");
CREATE UNIQUE INDEX "email_templates_projectId_name_key" ON "email_templates"("projectId", "name");
CREATE INDEX "email_templates_projectId_status_updatedAt_idx" ON "email_templates"("projectId", "status", "updatedAt");
CREATE UNIQUE INDEX "email_template_versions_projectId_id_key" ON "email_template_versions"("projectId", "id");
CREATE UNIQUE INDEX "email_template_versions_projectId_templateId_version_key" ON "email_template_versions"("projectId", "templateId", "version");
CREATE INDEX "email_template_versions_projectId_templateId_status_idx" ON "email_template_versions"("projectId", "templateId", "status");
CREATE UNIQUE INDEX "email_campaigns_projectId_id_key" ON "email_campaigns"("projectId", "id");
CREATE UNIQUE INDEX "email_campaigns_projectId_name_key" ON "email_campaigns"("projectId", "name");
CREATE INDEX "email_campaigns_projectId_status_scheduledAt_idx" ON "email_campaigns"("projectId", "status", "scheduledAt");
CREATE UNIQUE INDEX "email_deliveries_projectId_id_key" ON "email_deliveries"("projectId", "id");
CREATE UNIQUE INDEX "email_deliveries_projectId_campaignId_contactId_key" ON "email_deliveries"("projectId", "campaignId", "contactId");
CREATE UNIQUE INDEX "email_deliveries_projectId_scenarioExecutionId_nodeId_key" ON "email_deliveries"("projectId", "scenarioExecutionId", "nodeId");
CREATE UNIQUE INDEX "email_deliveries_unsubscribeToken_key" ON "email_deliveries"("unsubscribeToken");
CREATE UNIQUE INDEX "email_deliveries_providerEmailId_key" ON "email_deliveries"("providerEmailId");
CREATE INDEX "email_deliveries_status_nextAttemptAt_idx" ON "email_deliveries"("status", "nextAttemptAt");
CREATE INDEX "email_deliveries_projectId_campaignId_status_idx" ON "email_deliveries"("projectId", "campaignId", "status");
CREATE INDEX "email_deliveries_projectId_contactId_createdAt_idx" ON "email_deliveries"("projectId", "contactId", "createdAt");
CREATE UNIQUE INDEX "email_events_projectId_id_key" ON "email_events"("projectId", "id");
CREATE UNIQUE INDEX "email_events_providerEventId_key" ON "email_events"("providerEventId");
CREATE INDEX "email_events_projectId_deliveryId_occurredAt_idx" ON "email_events"("projectId", "deliveryId", "occurredAt");
CREATE UNIQUE INDEX "email_suppressions_projectId_normalizedEmail_key" ON "email_suppressions"("projectId", "normalizedEmail");
CREATE INDEX "email_suppressions_projectId_reason_createdAt_idx" ON "email_suppressions"("projectId", "reason", "createdAt");
CREATE UNIQUE INDEX "email_asset_references_projectId_mediaAssetId_ownerType_ownerId_key" ON "email_asset_references"("projectId", "mediaAssetId", "ownerType", "ownerId");
CREATE INDEX "email_asset_references_projectId_ownerType_ownerId_idx" ON "email_asset_references"("projectId", "ownerType", "ownerId");
CREATE INDEX "contacts_projectId_emailConsentStatus_idx" ON "contacts"("projectId", "emailConsentStatus");

ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_projectId_templateId_fkey" FOREIGN KEY ("projectId", "templateId") REFERENCES "email_templates"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_projectId_campaignId_fkey" FOREIGN KEY ("projectId", "campaignId") REFERENCES "email_campaigns"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_projectId_contactId_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_projectId_deliveryId_fkey" FOREIGN KEY ("projectId", "deliveryId") REFERENCES "email_deliveries"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_asset_references" ADD CONSTRAINT "email_asset_references_projectId_mediaAssetId_fkey" FOREIGN KEY ("projectId", "mediaAssetId") REFERENCES "media_assets"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
