ALTER TYPE "CrmOperationType" ADD VALUE IF NOT EXISTS 'FORWARD_TRACKED_LINK_CLICK';

ALTER TABLE "contacts"
  ADD COLUMN "normalizedPhone" TEXT,
  ADD COLUMN "normalizedEmail" TEXT;

UPDATE "contacts"
SET
  "normalizedEmail" = CASE
    WHEN "email" IS NULL OR BTRIM("email") = '' THEN NULL
    ELSE LOWER(BTRIM("email"))
  END,
  "normalizedPhone" = CASE
    WHEN "phone" IS NULL OR BTRIM("phone") = '' THEN NULL
    ELSE NULLIF(REGEXP_REPLACE("phone", '[^0-9]', '', 'g'), '')
  END;

CREATE INDEX "contacts_projectId_normalizedPhone_idx"
  ON "contacts"("projectId", "normalizedPhone");
CREATE INDEX "contacts_projectId_normalizedEmail_idx"
  ON "contacts"("projectId", "normalizedEmail");

CREATE OR REPLACE FUNCTION "normalize_contact_identity"()
RETURNS TRIGGER AS $$
BEGIN
  NEW."normalizedEmail" := CASE
    WHEN NEW."email" IS NULL OR BTRIM(NEW."email") = '' THEN NULL
    ELSE LOWER(BTRIM(NEW."email"))
  END;
  NEW."normalizedPhone" := CASE
    WHEN NEW."phone" IS NULL OR BTRIM(NEW."phone") = '' THEN NULL
    ELSE NULLIF(REGEXP_REPLACE(NEW."phone", '[^0-9]', '', 'g'), '')
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contacts_normalize_identity"
BEFORE INSERT OR UPDATE OF "email", "phone" ON "contacts"
FOR EACH ROW EXECUTE FUNCTION "normalize_contact_identity"();

ALTER TABLE "scenario_executions"
  ALTER COLUMN "conversationId" DROP NOT NULL,
  ALTER COLUMN "triggerEventId" DROP NOT NULL,
  ALTER COLUMN "conversationSequence" DROP NOT NULL,
  ADD COLUMN "triggerType" TEXT NOT NULL DEFAULT 'INCOMING_MESSAGE',
  ADD COLUMN "triggerPayload" JSONB;

CREATE TABLE "lead_capture_events" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 12,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "processedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "lead_capture_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lead_capture_events_project_source_idempotency_key"
  ON "lead_capture_events"("projectId", "sourceKey", "idempotencyKey");
CREATE INDEX "lead_capture_events_status_next_idx"
  ON "lead_capture_events"("status", "nextAttemptAt");
CREATE INDEX "lead_capture_events_project_contact_created_idx"
  ON "lead_capture_events"("projectId", "contactId", "createdAt");

CREATE TABLE "tracked_links" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "scenarioExecutionId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "firstClickedAt" TIMESTAMPTZ(3),
  "lastClickedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tracked_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tracked_links_token_key" ON "tracked_links"("token");
CREATE UNIQUE INDEX "tracked_links_execution_node_target_key"
  ON "tracked_links"("projectId", "scenarioExecutionId", "nodeId", "targetUrl");
CREATE INDEX "tracked_links_execution_created_idx"
  ON "tracked_links"("scenarioExecutionId", "createdAt");
CREATE INDEX "tracked_links_project_contact_created_idx"
  ON "tracked_links"("projectId", "contactId", "createdAt");

CREATE TABLE "tracked_link_clicks" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "trackedLinkId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userAgent" TEXT,
  "referrer" TEXT,
  "ipHash" TEXT,
  "isLikelyBot" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "tracked_link_clicks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tracked_link_clicks_link_occurred_idx"
  ON "tracked_link_clicks"("trackedLinkId", "occurredAt");
CREATE INDEX "tracked_link_clicks_project_contact_occurred_idx"
  ON "tracked_link_clicks"("projectId", "contactId", "occurredAt");
