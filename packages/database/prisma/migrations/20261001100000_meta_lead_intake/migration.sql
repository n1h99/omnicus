-- Additive only; no existing lead/contact or environment is modified.
CREATE TABLE "meta_lead_configs" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "pageId" TEXT NOT NULL,
  "formIds" TEXT[] NOT NULL, "graphVersion" TEXT NOT NULL DEFAULT 'v26.0',
  "credentialsEncrypted" JSONB NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "deliveryEnabled" BOOLEAN NOT NULL DEFAULT false, "liveFrom" TIMESTAMPTZ(3),
  "verifiedAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "meta_lead_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meta_lead_configs_projectId_key" ON "meta_lead_configs"("projectId");
CREATE UNIQUE INDEX "meta_lead_configs_pageId_key" ON "meta_lead_configs"("pageId");
CREATE UNIQUE INDEX "meta_lead_configs_projectId_id_key" ON "meta_lead_configs"("projectId", "id");
ALTER TABLE "meta_lead_configs" ADD CONSTRAINT "meta_lead_configs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "meta_lead_submissions" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "configId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL, "formId" TEXT NOT NULL, "leadId" TEXT NOT NULL,
  "payload" JSONB, "state" TEXT NOT NULL DEFAULT 'FETCH',
  "historical" BOOLEAN NOT NULL DEFAULT false, "approved" BOOLEAN NOT NULL DEFAULT false,
  "notify" BOOLEAN NOT NULL DEFAULT false, "result" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT,
  "lockedBy" TEXT, "lockedUntil" TIMESTAMPTZ(3),
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "meta_lead_submissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meta_lead_submissions_projectId_pageId_leadId_key" ON "meta_lead_submissions"("projectId", "pageId", "leadId");
CREATE INDEX "meta_lead_submissions_state_nextAttemptAt_lockedUntil_idx" ON "meta_lead_submissions"("state", "nextAttemptAt", "lockedUntil");
CREATE INDEX "meta_lead_submissions_projectId_createdAt_idx" ON "meta_lead_submissions"("projectId", "createdAt");
ALTER TABLE "meta_lead_submissions" ADD CONSTRAINT "meta_lead_submissions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meta_lead_submissions" ADD CONSTRAINT "meta_lead_submissions_projectId_configId_fkey" FOREIGN KEY ("projectId", "configId") REFERENCES "meta_lead_configs"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "meta_lead_polls" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "configId" TEXT NOT NULL,
  "formId" TEXT NOT NULL, "historical" BOOLEAN NOT NULL DEFAULT false,
  "from" TIMESTAMPTZ(3) NOT NULL, "until" TIMESTAMPTZ(3), "cursor" TEXT,
  "completed" BOOLEAN NOT NULL DEFAULT false, "lastError" TEXT,
  "lockedBy" TEXT, "lockedUntil" TIMESTAMPTZ(3),
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meta_lead_polls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "meta_lead_polls_completed_nextAttemptAt_lockedUntil_idx" ON "meta_lead_polls"("completed", "nextAttemptAt", "lockedUntil");
ALTER TABLE "meta_lead_polls" ADD CONSTRAINT "meta_lead_polls_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meta_lead_polls" ADD CONSTRAINT "meta_lead_polls_projectId_configId_fkey" FOREIGN KEY ("projectId", "configId") REFERENCES "meta_lead_configs"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
