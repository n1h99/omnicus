-- AlterEnum
ALTER TYPE "EmailDeliverySource" ADD VALUE 'MANUAL';

-- AlterEnum
ALTER TYPE "EmailDeliveryStatus" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "scenario_executions" ADD COLUMN     "emailThreadId" TEXT;

-- AlterTable
ALTER TABLE "wait_states" ADD COLUMN     "emailThreadId" TEXT,
ADD COLUMN     "resolvedByEmailMessageId" TEXT,
ALTER COLUMN "conversationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "email_campaigns" ADD COLUMN     "mailboxId" TEXT;

-- AlterTable
ALTER TABLE "email_deliveries" ADD COLUMN     "firstAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN     "headersSnapshot" JSONB,
ADD COLUMN     "mailboxId" TEXT,
ADD COLUMN     "renderedHtml" TEXT,
ADD COLUMN     "renderedText" TEXT,
ADD COLUMN     "replyToSnapshot" TEXT,
ADD COLUMN     "rfcMessageId" TEXT,
ADD COLUMN     "senderSnapshot" TEXT;

-- CreateTable
CREATE TABLE "email_domains" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerDomainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "sendingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "receivingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "receivingReady" BOOLEAN NOT NULL DEFAULT false,
    "region" TEXT,
    "dnsRecords" JSONB NOT NULL DEFAULT '[]',
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_mailboxes" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "signature" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL DEFAULT 'TWO_WAY',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "shared" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_mailbox_members" (
    "projectId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "email_mailbox_members_pkey" PRIMARY KEY ("projectId","mailboxId","userId")
);

-- CreateTable
CREATE TABLE "email_threads" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "contactId" TEXT,
    "peerEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "replyToken" TEXT NOT NULL,
    "preview" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMPTZ(3),
    "lastOutboundAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "providerEmailId" TEXT,
    "rfcMessageId" TEXT,
    "inReplyTo" TEXT,
    "referencesHeader" TEXT,
    "direction" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "replyToAddress" TEXT,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL DEFAULT '',
    "htmlBody" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "requestKey" TEXT,
    "requestHash" TEXT,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "automationStatus" TEXT NOT NULL DEFAULT 'NONE',
    "automationError" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_inbound_receipts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "providerEmailId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "processedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_inbound_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_thread_user_states" (
    "projectId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "starred" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "email_thread_user_states_pkey" PRIMARY KEY ("projectId","threadId","userId")
);

-- CreateTable
CREATE TABLE "email_drafts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT,
    "toEmail" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "textBody" TEXT NOT NULL DEFAULT '',
    "assetIds" JSONB NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_attachments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "providerAttachmentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "contentId" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "bucketKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_domains_providerDomainId_key" ON "email_domains"("providerDomainId");

-- CreateIndex
CREATE UNIQUE INDEX "email_domains_name_key" ON "email_domains"("name");

-- CreateIndex
CREATE UNIQUE INDEX "email_domains_projectId_id_key" ON "email_domains"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_mailboxes_address_key" ON "email_mailboxes"("address");

-- CreateIndex
CREATE INDEX "email_mailboxes_projectId_status_idx" ON "email_mailboxes"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_mailboxes_projectId_id_key" ON "email_mailboxes"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_replyToken_key" ON "email_threads"("replyToken");

-- CreateIndex
CREATE INDEX "email_threads_projectId_mailboxId_lastMessageAt_idx" ON "email_threads"("projectId", "mailboxId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "email_threads_projectId_contactId_lastMessageAt_idx" ON "email_threads"("projectId", "contactId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_projectId_id_key" ON "email_threads"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_projectId_mailboxId_id_key" ON "email_threads"("projectId", "mailboxId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_deliveryId_key" ON "email_messages"("deliveryId");

-- CreateIndex
CREATE INDEX "email_messages_projectId_mailboxId_rfcMessageId_idx" ON "email_messages"("projectId", "mailboxId", "rfcMessageId");

-- CreateIndex
CREATE INDEX "email_messages_projectId_threadId_occurredAt_idx" ON "email_messages"("projectId", "threadId", "occurredAt");

-- CreateIndex
CREATE INDEX "email_messages_automationStatus_occurredAt_idx" ON "email_messages"("automationStatus", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_projectId_id_key" ON "email_messages"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_projectId_deliveryId_key" ON "email_messages"("projectId", "deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_projectId_requestKey_key" ON "email_messages"("projectId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_mailboxId_direction_providerEmailId_key" ON "email_messages"("mailboxId", "direction", "providerEmailId");

-- CreateIndex
CREATE INDEX "email_inbound_receipts_status_nextAttemptAt_idx" ON "email_inbound_receipts"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_inbound_receipts_projectId_id_key" ON "email_inbound_receipts"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_inbound_receipts_mailboxId_providerEmailId_key" ON "email_inbound_receipts"("mailboxId", "providerEmailId");

-- CreateIndex
CREATE INDEX "email_drafts_projectId_userId_updatedAt_idx" ON "email_drafts"("projectId", "userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_drafts_projectId_id_key" ON "email_drafts"("projectId", "id");

-- CreateIndex
CREATE INDEX "email_attachments_projectId_messageId_idx" ON "email_attachments"("projectId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_attachments_projectId_id_key" ON "email_attachments"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_attachments_projectId_messageId_providerAttachmentId_key" ON "email_attachments"("projectId", "messageId", "providerAttachmentId");

-- CreateIndex
CREATE INDEX "wait_states_projectId_emailThreadId_status_idx" ON "wait_states"("projectId", "emailThreadId", "status");

-- AddForeignKey
ALTER TABLE "scenario_executions" ADD CONSTRAINT "scenario_executions_projectId_emailThreadId_fkey" FOREIGN KEY ("projectId", "emailThreadId") REFERENCES "email_threads"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wait_states" ADD CONSTRAINT "wait_states_projectId_emailThreadId_fkey" FOREIGN KEY ("projectId", "emailThreadId") REFERENCES "email_threads"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wait_states" ADD CONSTRAINT "wait_states_projectId_resolvedByEmailMessageId_fkey" FOREIGN KEY ("projectId", "resolvedByEmailMessageId") REFERENCES "email_messages"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_projectId_domainId_fkey" FOREIGN KEY ("projectId", "domainId") REFERENCES "email_domains"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_mailbox_members" ADD CONSTRAINT "email_mailbox_members_projectId_mailboxId_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "email_mailboxes"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_mailbox_members" ADD CONSTRAINT "email_mailbox_members_projectId_userId_fkey" FOREIGN KEY ("projectId", "userId") REFERENCES "project_memberships"("projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_projectId_mailboxId_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "email_mailboxes"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_projectId_contactId_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_projectId_mailboxId_threadId_fkey" FOREIGN KEY ("projectId", "mailboxId", "threadId") REFERENCES "email_threads"("projectId", "mailboxId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_projectId_deliveryId_fkey" FOREIGN KEY ("projectId", "deliveryId") REFERENCES "email_deliveries"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_inbound_receipts" ADD CONSTRAINT "email_inbound_receipts_projectId_mailboxId_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "email_mailboxes"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_thread_user_states" ADD CONSTRAINT "email_thread_user_states_projectId_threadId_fkey" FOREIGN KEY ("projectId", "threadId") REFERENCES "email_threads"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_thread_user_states" ADD CONSTRAINT "email_thread_user_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_projectId_mailboxId_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "email_mailboxes"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_projectId_mailboxId_threadId_fkey" FOREIGN KEY ("projectId", "mailboxId", "threadId") REFERENCES "email_threads"("projectId", "mailboxId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_projectId_messageId_fkey" FOREIGN KEY ("projectId", "messageId") REFERENCES "email_messages"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_projectId_mailboxId_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "email_mailboxes"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_projectId_mailboxId_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "email_mailboxes"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Mailbox defaults and permitted modes are enforced in storage, not only UI.
CREATE UNIQUE INDEX "email_mailboxes_one_default_per_project" ON "email_mailboxes"("projectId") WHERE "isDefault" = true;
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_mode_check" CHECK ("mode" IN ('TWO_WAY', 'SEND_ONLY'));
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_status_check" CHECK ("status" IN ('ACTIVE', 'DISABLED'));
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_default_shared_check" CHECK (NOT "isDefault" OR "shared");
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_direction_check" CHECK ("direction" IN ('INBOUND', 'OUTBOUND'));
ALTER TABLE "wait_states" ADD CONSTRAINT "wait_states_exactly_one_target" CHECK (num_nonnulls("conversationId", "emailThreadId") = 1);
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_size_check" CHECK ("sizeBytes" >= 0);

INSERT INTO "permissions" ("id", "code", "description") VALUES
('email-read-20260915', 'email:read', 'Read assigned project email mailboxes'),
('email-send-20260915', 'email:send', 'Compose and reply from assigned mailboxes'),
('email-manage-20260915', 'email:manage', 'Manage project mailboxes and assignments')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "project_role_permissions" ("projectId", "projectRoleId", "permissionId")
SELECT r."projectId", r."id", p."id" FROM "project_roles" r CROSS JOIN "permissions" p
WHERE r."system" = true AND r."normalizedName" = 'project-admin' AND p."code" IN ('email:read', 'email:send', 'email:manage')
ON CONFLICT DO NOTHING;
