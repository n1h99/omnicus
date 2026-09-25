CREATE TABLE "email_message_crm_reads" (
    "projectId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "readByUserId" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_message_crm_reads_pkey" PRIMARY KEY ("projectId", "messageId")
);

ALTER TABLE "email_message_crm_reads" ADD CONSTRAINT "email_message_crm_reads_projectId_messageId_fkey"
    FOREIGN KEY ("projectId", "messageId") REFERENCES "email_messages"("projectId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
