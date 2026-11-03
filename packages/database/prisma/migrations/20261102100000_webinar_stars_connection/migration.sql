-- ADR-067: one encrypted, project-owned Webinar Stars connection.
CREATE TABLE "webinar_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tokenEncrypted" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "webinar_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webinar_connections_projectId_key" ON "webinar_connections"("projectId");
ALTER TABLE "webinar_connections" ADD CONSTRAINT "webinar_connections_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
