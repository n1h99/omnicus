-- AlterTable
ALTER TABLE "webinar_connections" ADD COLUMN     "connected" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enabledAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastPollError" TEXT,
ADD COLUMN     "nextPollAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "pollLockedBy" TEXT,
ADD COLUMN     "pollLockedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "pollOffset" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pollStartedAt" TIMESTAMPTZ(3),
ADD COLUMN     "webhookSecretHash" TEXT,
ALTER COLUMN "tokenEncrypted" DROP NOT NULL;

-- AlterTable
ALTER TABLE "email_deliveries" ADD COLUMN     "variablesSnapshot" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "webinar_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerWebinarId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "roomUrl" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webinar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webinar_invitations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "attribution" JSONB NOT NULL DEFAULT '{}',
    "openedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webinar_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webinar_webhook_receipts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webinar_webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webinar_report_imports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalReportId" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'POLL',
    "eventId" TEXT,
    "historical" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "requestedVersion" INTEGER NOT NULL DEFAULT 1,
    "fingerprint" TEXT,
    "summary" JSONB,
    "lastError" TEXT,
    "processedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webinar_report_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webinar_attendances" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "contactId" TEXT,
    "invitationId" TEXT,
    "matchState" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchReason" TEXT,
    "result" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webinar_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webinar_actions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webinar_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webinar_events_projectId_scheduledAt_idx" ON "webinar_events"("projectId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_events_projectId_id_key" ON "webinar_events"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_invitations_token_key" ON "webinar_invitations"("token");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_invitations_projectId_id_key" ON "webinar_invitations"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_invitations_projectId_eventId_contactId_key" ON "webinar_invitations"("projectId", "eventId", "contactId");

-- CreateIndex
CREATE INDEX "webinar_webhook_receipts_createdAt_idx" ON "webinar_webhook_receipts"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_webhook_receipts_projectId_connectionId_fingerprint_key" ON "webinar_webhook_receipts"("projectId", "connectionId", "fingerprint");

-- CreateIndex
CREATE INDEX "webinar_report_imports_state_nextAttemptAt_lockedUntil_idx" ON "webinar_report_imports"("state", "nextAttemptAt", "lockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_report_imports_projectId_id_key" ON "webinar_report_imports"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_report_imports_projectId_connectionId_externalRepor_key" ON "webinar_report_imports"("projectId", "connectionId", "externalReportId");

-- CreateIndex
CREATE INDEX "webinar_attendances_projectId_matchState_idx" ON "webinar_attendances"("projectId", "matchState");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_attendances_projectId_id_key" ON "webinar_attendances"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_attendances_projectId_importId_identityKey_key" ON "webinar_attendances"("projectId", "importId", "identityKey");

-- CreateIndex
CREATE INDEX "webinar_actions_state_dueAt_lockedUntil_idx" ON "webinar_actions"("state", "dueAt", "lockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_actions_projectId_id_key" ON "webinar_actions"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_actions_projectId_kind_dedupeKey_key" ON "webinar_actions"("projectId", "kind", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "webinar_connections_projectId_id_key" ON "webinar_connections"("projectId", "id");

-- AddForeignKey
ALTER TABLE "webinar_events" ADD CONSTRAINT "webinar_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_events" ADD CONSTRAINT "webinar_events_projectId_connectionId_fkey" FOREIGN KEY ("projectId", "connectionId") REFERENCES "webinar_connections"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_invitations" ADD CONSTRAINT "webinar_invitations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_invitations" ADD CONSTRAINT "webinar_invitations_projectId_eventId_fkey" FOREIGN KEY ("projectId", "eventId") REFERENCES "webinar_events"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_invitations" ADD CONSTRAINT "webinar_invitations_projectId_contactId_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_webhook_receipts" ADD CONSTRAINT "webinar_webhook_receipts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_webhook_receipts" ADD CONSTRAINT "webinar_webhook_receipts_projectId_connectionId_fkey" FOREIGN KEY ("projectId", "connectionId") REFERENCES "webinar_connections"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_report_imports" ADD CONSTRAINT "webinar_report_imports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_report_imports" ADD CONSTRAINT "webinar_report_imports_projectId_connectionId_fkey" FOREIGN KEY ("projectId", "connectionId") REFERENCES "webinar_connections"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_report_imports" ADD CONSTRAINT "webinar_report_imports_projectId_eventId_fkey" FOREIGN KEY ("projectId", "eventId") REFERENCES "webinar_events"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_attendances" ADD CONSTRAINT "webinar_attendances_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_attendances" ADD CONSTRAINT "webinar_attendances_projectId_importId_fkey" FOREIGN KEY ("projectId", "importId") REFERENCES "webinar_report_imports"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_attendances" ADD CONSTRAINT "webinar_attendances_projectId_contactId_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_attendances" ADD CONSTRAINT "webinar_attendances_projectId_invitationId_fkey" FOREIGN KEY ("projectId", "invitationId") REFERENCES "webinar_invitations"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_actions" ADD CONSTRAINT "webinar_actions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webinar_actions" ADD CONSTRAINT "webinar_actions_projectId_contactId_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

