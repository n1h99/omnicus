CREATE TABLE "communication_entries" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "contactId" TEXT,
  "ownerUserId" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "communication_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "communication_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "communication_entries_projectId_contactId_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "contacts"("projectId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "communication_entries_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "communication_entries_projectId_namespace_key_key" ON "communication_entries"("projectId", "namespace", "key");
CREATE INDEX "communication_entries_projectId_contactId_kind_createdAt_idx" ON "communication_entries"("projectId", "contactId", "kind", "createdAt");
